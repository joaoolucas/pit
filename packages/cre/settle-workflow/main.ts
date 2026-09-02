/**
 * Pit's operating loop — a Chainlink CRE workflow.
 *
 * Every 30 seconds, two jobs against the same price:
 *
 *   1. read the onchain clock — `PitFactory.pendingSettlement` returns the
 *      windows whose `endTs` has passed and that nobody has resolved
 *   2. read the reference price off-chain over HTTP, once per DON node, and take
 *      the median
 *   3. settle: encode one report for the whole batch, have the DON sign it, and
 *      write it to PitSettlementReceiver, which calls `settle` for each window
 *   4. roll: build the strike ladder around that same price, ask
 *      `PitFactory.missingWindows` which cells of the next columns do not exist,
 *      and write a second report to PitRollReceiver, which opens them
 *
 * Why this shape:
 *
 *   - The clock is onchain and the price is offchain, and CRE is the only piece
 *     that can hold both in one attested execution. That is the entire reason it
 *     is here rather than a cron job with a private key — and it is as true of
 *     opening a column as of settling one, because the strike ladder is anchored
 *     to spot. A board of five-minute markets is an operation, not a deployment;
 *     the operation now has no operator.
 *   - One report settles a whole column. Seven strikes close at the same instant
 *     on a 5-minute grid; seven reports carrying the same price would be waste.
 *   - Two reports, not one. Opening a cell deploys two ERC20s and lists two Kuru
 *     markets; settling writes a word. Putting them in one report would size one
 *     gas limit for both and leave settlement — where somebody's money is
 *     waiting — queued behind the most expensive write in the system.
 *   - The workflow is stateless. It never remembers what it settled or opened;
 *     the chain is the state, and the two views are the queries.
 *
 * Simulate:  cre workflow simulate settle-workflow --target staging-settings
 */
import {
  consensusMedianAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  handler,
  json,
  ok,
  prepareReportRequest,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import type { HTTPSendRequester } from "@chainlink/cre-sdk";
import {
  bytesToHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
} from "viem";

import { PIT_FACTORY_ABI } from "./abi";
import { strikeLadder, upcomingWindowEnds, WINDOW_SECONDS } from "./ladder";
import { formatE8, parseE8 } from "./price";

type EvmTarget = {
  /** A CRE chain selector name, e.g. "monad-testnet". */
  chainName: string;
  isTestnet: boolean;
  pitFactoryAddress: Address;
  receiverAddress: Address;
  gasLimit: string;
  /** How many of the newest windows to scan for stragglers. */
  lookbackWindows: number;
  /** Cap on windows per report. Also caps the gas one report can burn. */
  maxWindowsPerReport: number;

  /** Where roll reports go. PitRollReceiver, which is the factory's operator. */
  rollReceiverAddress: Address;
  /**
   * Gas for a roll report, which is a different animal from a settle report:
   * every cell deploys two ERC20s and lists two Kuru markets.
   */
  rollGasLimit: string;
  /** Columns kept open ahead of the live one. */
  columns: number;
  /** Rows on the ladder. Odd, so there is a middle — the up/down cell. */
  ladderRows: number;
  /** Row spacing, in basis points of spot. */
  ladderStepBps: number;
  /**
   * Cap on cells per roll report.
   *
   * Small on purpose. A cold board needs columns x rows cells and will fill over
   * several passes; steady state is one column of new cells every five minutes,
   * which any cap above a row's worth keeps up with easily.
   */
  maxOpensPerReport: number;
};

type Config = {
  schedule: string;
  /** Reference price endpoint. The seeding script reads the same one. */
  priceUrl: string;
  /** Human label, only for logs. */
  underlying: string;
  evms: EvmTarget[];
};

/** Nobody sends this call, so the `from` is the zero address. */
const NO_SENDER = "0x0000000000000000000000000000000000000000" as const;

const onCron = async (runtime: Runtime<Config>): Promise<string> => {
  const target = runtime.config.evms[0];
  if (!target) throw new Error("config.evms is empty");

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: target.chainName,
    isTestnet: target.isTestnet,
  });
  if (!network) {
    throw new Error(`Unknown chain selector "${target.chainName}". See EVMClient.SUPPORTED_CHAIN_SELECTORS.`);
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  // --- 1. the onchain clock ------------------------------------------------
  const pendingCall = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: NO_SENDER,
        to: target.pitFactoryAddress,
        data: encodeFunctionData({
          abi: PIT_FACTORY_ABI,
          functionName: "pendingSettlement",
          args: [BigInt(target.lookbackWindows), BigInt(target.maxWindowsPerReport)],
        }),
      }),
    })
    .result();

  const pending = decodeFunctionResult({
    abi: PIT_FACTORY_ABI,
    functionName: "pendingSettlement",
    data: bytesToHex(pendingCall.data),
  }) as readonly bigint[];

  if (pending.length > 0) {
    runtime.log(`${pending.length} window(s) waiting: ${pending.join(", ")}`);
  }

  // --- 2. the offchain price ----------------------------------------------
  // Each node fetches independently; the DON agrees on the median. A single node
  // seeing a bad tick cannot move the settlement.
  //
  // Fetched every pass, not only when something is closing, because the ladder
  // the roller opens is anchored to it too.
  const httpClient = new cre.capabilities.HTTPClient();
  const priceE8 = httpClient
    .sendRequest(runtime, fetchPriceE8, consensusMedianAggregation<bigint>())(runtime.config.priceUrl)
    .result();

  if (priceE8 <= 0n) throw new Error(`Refusing to act on a non-positive price (${priceE8})`);
  runtime.log(`${runtime.config.underlying} reference price: ${formatE8(priceE8)}`);

  const done: string[] = [];

  // --- 3. settle: one signed report for the whole batch -------------------
  if (pending.length > 0) {
    const payload = encodeAbiParameters(parseAbiParameters("uint256 priceE8, uint256[] windowIds"), [
      priceE8,
      [...pending],
    ]);

    const report = runtime.report(prepareReportRequest(payload)).result();

    const write = evmClient
      .writeReport(runtime, {
        receiver: target.receiverAddress,
        report,
        gasConfig: { gasLimit: target.gasLimit },
      })
      .result();

    runtime.log(`Settled ${pending.length} window(s) at ${formatE8(priceE8)} — tx ${txHashOf(write)}`);
    done.push(`settled ${pending.length}`);
  }

  // --- 4. roll: open whatever the next columns are missing -----------------
  //
  // The ladder is built here rather than onchain because it is a function of the
  // price, and this is the only place that has an attested one. The factory is
  // asked which of those cells do not exist, so a report only ever carries work
  // that still needs doing — the same stateless shape as settlement.
  const underlyingKey = keccak256(stringToHex(runtime.config.underlying));
  const ends = upcomingWindowEnds(nowSeconds(), target.columns);
  const strikes = strikeLadder(priceE8, target.ladderRows, target.ladderStepBps);

  const missingCall = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: NO_SENDER,
        to: target.pitFactoryAddress,
        data: encodeFunctionData({
          abi: PIT_FACTORY_ABI,
          functionName: "missingWindows",
          args: [underlyingKey, ends.map((e) => BigInt(e)), strikes, BigInt(target.maxOpensPerReport)],
        }),
      }),
    })
    .result();

  const [missingEnds, missingStrikes] = decodeFunctionResult({
    abi: PIT_FACTORY_ABI,
    functionName: "missingWindows",
    data: bytesToHex(missingCall.data),
  }) as readonly [readonly bigint[], readonly bigint[]];

  if (missingEnds.length > 0) {
    const rollPayload = encodeAbiParameters(
      parseAbiParameters("bytes32 underlying, uint64 windowSeconds, uint64[] ends, uint256[] strikeE8s"),
      [underlyingKey, BigInt(WINDOW_SECONDS), [...missingEnds], [...missingStrikes]],
    );

    const rollReport = runtime.report(prepareReportRequest(rollPayload)).result();

    const rollWrite = evmClient
      .writeReport(runtime, {
        receiver: target.rollReceiverAddress,
        report: rollReport,
        gasConfig: { gasLimit: target.rollGasLimit },
      })
      .result();

    runtime.log(`Opened ${missingEnds.length} cell(s) — tx ${txHashOf(rollWrite)}`);
    done.push(`opened ${missingEnds.length}`);
  }

  if (done.length === 0) {
    runtime.log("Nothing closing and nothing missing. The board is current.");
    return "idle";
  }

  return `${done.join(", ")} at ${formatE8(priceE8)}`;
};

/** Unix seconds. The workflow's own clock, only ever used to pick columns. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const txHashOf = (write: { txStatus?: unknown; txHash?: Uint8Array }): string =>
  write.txStatus !== undefined ? bytesToHex(write.txHash ?? new Uint8Array()) : "(pending)";

/**
 * Runs on each DON node. Returns the price scaled by 1e8, the same scale
 * PitFactory stores strikes in, so no conversion happens anywhere else.
 *
 * Returning a bigint rather than a float matters: median consensus over floats
 * would let representation noise decide a window that settles on the last cent.
 */
const fetchPriceE8 = (sendRequester: HTTPSendRequester, url: string): bigint => {
  const response = sendRequester.sendRequest({ url, method: "GET" }).result();
  if (!ok(response)) throw new Error(`Price endpoint returned ${response.statusCode}`);

  const body = json(response) as { data?: { amount?: string } };
  const amount = body?.data?.amount;
  if (typeof amount !== "string") {
    throw new Error(`Unexpected price payload: ${JSON.stringify(body).slice(0, 200)}`);
  }

  return parseE8(amount);
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

await main();
