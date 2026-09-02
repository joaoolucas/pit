/**
 * Cell settlement — a Chainlink CRE workflow.
 *
 * Every 30 seconds:
 *
 *   1. read the onchain clock — `CellFactory.pendingSettlement` returns the
 *      windows whose `endTs` has passed and that nobody has resolved
 *   2. if there are any, read the reference price off-chain over HTTP, once per
 *      DON node, and take the median
 *   3. encode one report for the whole batch, have the DON sign it, and write it
 *      to CellSettlementReceiver, which calls `settle` for each window
 *
 * Why this shape:
 *
 *   - The clock is onchain and the price is offchain, and CRE is the only piece
 *     that can hold both in one attested execution. That is the entire reason it
 *     is here rather than a cron job with a private key.
 *   - One report settles a whole column. Seven strikes close at the same instant
 *     on a 5-minute grid; seven reports carrying the same price would be waste.
 *   - The workflow is stateless. It never remembers what it settled; the chain
 *     is the state, and `pendingSettlement` is the query.
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
  parseAbiParameters,
  type Address,
} from "viem";

import { CELL_FACTORY_ABI } from "./abi";
import { formatE8, parseE8 } from "./price";

type EvmTarget = {
  /** A CRE chain selector name, e.g. "monad-testnet". */
  chainName: string;
  isTestnet: boolean;
  cellFactoryAddress: Address;
  receiverAddress: Address;
  gasLimit: string;
  /** How many of the newest windows to scan for stragglers. */
  lookbackWindows: number;
  /** Cap on windows per report. Also caps the gas one report can burn. */
  maxWindowsPerReport: number;
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
        to: target.cellFactoryAddress,
        data: encodeFunctionData({
          abi: CELL_FACTORY_ABI,
          functionName: "pendingSettlement",
          args: [BigInt(target.lookbackWindows), BigInt(target.maxWindowsPerReport)],
        }),
      }),
    })
    .result();

  const pending = decodeFunctionResult({
    abi: CELL_FACTORY_ABI,
    functionName: "pendingSettlement",
    data: bytesToHex(pendingCall.data),
  }) as readonly bigint[];

  if (pending.length === 0) {
    runtime.log("No closed windows waiting on a price. Nothing to do.");
    return "idle";
  }

  runtime.log(`${pending.length} window(s) waiting: ${pending.join(", ")}`);

  // --- 2. the offchain price ----------------------------------------------
  // Each node fetches independently; the DON agrees on the median. A single node
  // seeing a bad tick cannot move the settlement.
  const httpClient = new cre.capabilities.HTTPClient();
  const priceE8 = httpClient
    .sendRequest(runtime, fetchPriceE8, consensusMedianAggregation<bigint>())(runtime.config.priceUrl)
    .result();

  if (priceE8 <= 0n) throw new Error(`Refusing to settle on a non-positive price (${priceE8})`);
  runtime.log(`${runtime.config.underlying} reference price: ${formatE8(priceE8)}`);

  // --- 3. one signed report for the whole batch ---------------------------
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

  const txHash = write.txStatus !== undefined ? bytesToHex(write.txHash ?? new Uint8Array()) : "(pending)";
  runtime.log(`Settled ${pending.length} window(s) at ${formatE8(priceE8)} — tx ${txHash}`);

  return `settled ${pending.length} at ${formatE8(priceE8)}`;
};

/**
 * Runs on each DON node. Returns the price scaled by 1e8, the same scale
 * CellFactory stores strikes in, so no conversion happens anywhere else.
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
