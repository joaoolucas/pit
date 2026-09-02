/**
 * Seeds both sides of every live cell.
 *
 * This is the liquidity plan as code. For each open window:
 *
 *   1. price a fair probability from spot, the strike, time left and realised vol
 *   2. mint sets so there is inventory to sell on both legs
 *   3. cancel our previous quotes and post a fresh bid and ask on the YES book
 *      and on the NO book, in one batchUpdate per market
 *
 * Nothing here is privileged: mintSet is the same call a trader makes, and the
 * orders rest on the same public book anyone else can hit.
 */
import { ethers, network } from "hardhat";
import type { ContractTransactionReceipt, Interface } from "ethers";
import fs from "node:fs";
import path from "node:path";

import { DEPLOYMENTS_DIR, fetchAnnualisedVol, fetchSpotE8, nowSeconds, readDeployment, usd } from "../lib";
import type { CellFactory, MockERC20 } from "../../typechain-types";
import { fairProbabilityAbove } from "../../../core/src/windows";
import { contractsToSize, probToTick, quoteCost, tickToProb } from "../../../core/src/kuru";

export type SeedOptions = {
  underlying?: string;
  /** Contracts quoted a side, per leg. 200 contracts == $200 of max payout. */
  contracts?: number;
  /** Total market width in probability bps. 200 == a 0.02 wide market. */
  spreadBps?: number;
  /** Stop quoting this close to the bell. */
  stopQuotingSeconds?: number;
  quiet?: boolean;
};

export type SeedResult = {
  quoted: number;
  skipped: number;
  spotE8: bigint;
  vol: number;
};

type QuoteBook = Record<string, number[]>;

const quotesPath = () => path.join(DEPLOYMENTS_DIR, `quotes.${network.name}.json`);

const readQuotes = (): QuoteBook => {
  const file = quotesPath();
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as QuoteBook) : {};
};

const writeQuotes = (quotes: QuoteBook) => {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(quotesPath(), `${JSON.stringify(quotes, null, 2)}\n`);
};

export async function seedBooks(options: SeedOptions = {}): Promise<SeedResult> {
  const label = options.underlying ?? process.env.UNDERLYING ?? "BTC-USD";
  const quoteContracts = options.contracts ?? Number(process.env.SIZE ?? 200);
  const spreadBps = options.spreadBps ?? Number(process.env.SPREAD_BPS ?? 200);
  const stopQuoting = options.stopQuotingSeconds ?? Number(process.env.STOP_QUOTING_SECONDS ?? 20);

  const deployment = readDeployment();
  const [maker] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CellFactory", deployment.cellFactory);
  const collateral = await ethers.getContractAt("MockERC20", deployment.collateral);
  const decimals = deployment.collateralDecimals;

  const spotE8 = await fetchSpotE8(label);
  const vol = await fetchAnnualisedVol(label);
  const now = nowSeconds();

  if (!options.quiet) {
    console.log(`${label} spot $${usd(spotE8)}   realised vol ${(vol * 100).toFixed(1)}%`);
  }
  await topUpFromFaucet(collateral, maker.address, decimals, options.quiet);
  if (!options.quiet) {
    const balance = ethers.formatUnits(await collateral.balanceOf(maker.address), decimals);
    console.log(`Maker ${maker.address}   ${balance} ${deployment.collateralSymbol}\n`);
  }

  const total = Number(await factory.windowCount());
  const windows = await factory.getWindows(0, total);
  const quotes = readQuotes();
  const size = contractsToSize(quoteContracts);
  const halfSpread = spreadBps / 20_000; // bps of probability, halved

  let quoted = 0;
  let skipped = 0;

  for (let windowId = 0; windowId < windows.length; windowId++) {
    const w = windows[windowId]!;
    const secondsRemaining = Number(w.endTs) - now;
    if (w.outcome !== 0n) continue;
    if (secondsRemaining <= stopQuoting) continue;

    const fairYes = fairProbabilityAbove(spotE8, w.strikeE8, secondsRemaining, vol);
    const at = new Date(Number(w.endTs) * 1000).toISOString().slice(11, 16);
    const label2 = `${at} $${usd(w.strikeE8)}`;

    // A cell only earns a quote if a fair price is actually inside the tradeable
    // band. Quoting 0.997 is not liquidity, it is an invitation to be picked off.
    if (fairYes < 0.02 || fairYes > 0.98) {
      skipped++;
      if (!options.quiet) {
        console.log(`  · ${label2}  fair ${fairYes.toFixed(3)} — outside the band, skipped`);
      }
      continue;
    }

    // Inventory: one set per contract we might sell, on either leg.
    await ensureInventory(factory, collateral, maker.address, windowId, w, size, decimals);

    for (const [side, market, token, fair] of [
      ["YES", w.yesMarket, w.yes, fairYes],
      ["NO", w.noMarket, w.no, 1 - fairYes],
    ] as const) {
      const bid = probToTick(fair - halfSpread);
      const ask = probToTick(fair + halfSpread);
      if (bid >= ask) continue;

      await approveIfNeeded(token, market, maker.address);
      await approveIfNeeded(deployment.collateral, market, maker.address);

      const book = await ethers.getContractAt("IKuruOrderBook", market);
      const stale = quotes[market.toLowerCase()] ?? [];

      const tx = await book.batchUpdate([bid], [size], [ask], [size], stale, true);
      const receipt = await tx.wait();

      quotes[market.toLowerCase()] = parseOrderIds(book.interface, receipt);
      quoted++;

      if (!options.quiet) {
        const risk = ethers.formatUnits(quoteCost(size, bid, decimals), decimals);
        console.log(
          `  ${side === "YES" ? "+" : " "} ${label2}  ${side.padEnd(3)} ` +
            `${tickToProb(bid).toFixed(3)} / ${tickToProb(ask).toFixed(3)}  ` +
            `${quoteContracts}x  risk $${risk}`,
        );
      }
    }
  }

  writeQuotes(quotes);
  return { quoted, skipped, spotE8, vol };
}

/**
 * Top the maker up from the faucet collateral. Only works on the test token; on
 * mainnet the maker funds itself and this quietly does nothing.
 */
async function topUpFromFaucet(collateral: MockERC20, maker: string, decimals: number, quiet?: boolean) {
  const floor = 50_000n * 10n ** BigInt(decimals);
  if ((await collateral.balanceOf(maker)) >= floor) return;
  try {
    await (await collateral.mint(maker, floor)).wait();
    if (!quiet) console.log(`Faucet: minted ${ethers.formatUnits(floor, decimals)} to the maker.`);
  } catch {
    console.warn("Collateral has no open faucet — fund the maker before seeding.");
  }
}

/** Mint enough sets that both legs can be sold at the quoted size. */
async function ensureInventory(
  factory: CellFactory,
  collateral: MockERC20,
  maker: string,
  windowId: number,
  w: { yes: string; no: string },
  size: bigint,
  decimals: number,
) {
  const needed = (size * 10n ** BigInt(decimals)) / 1_000_000n;
  const yes = await ethers.getContractAt("MockERC20", w.yes);
  const held = await yes.balanceOf(maker);
  if (held >= needed) return;

  const shortfall = needed - held;
  const factoryAddress = await factory.getAddress();
  if ((await collateral.allowance(maker, factoryAddress)) < shortfall) {
    await (await collateral.approve(factoryAddress, ethers.MaxUint256)).wait();
  }
  await (await factory.mintSet(windowId, shortfall)).wait();
}

async function approveIfNeeded(token: string, spender: string, owner: string) {
  const erc20 = await ethers.getContractAt("MockERC20", token);
  if ((await erc20.allowance(owner, spender)) > ethers.MaxUint256 / 2n) return;
  await (await erc20.approve(spender, ethers.MaxUint256)).wait();
}

function parseOrderIds(iface: Interface, receipt: ContractTransactionReceipt | null): number[] {
  if (!receipt) return [];
  const ids: number[] = [];
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "OrderCreated") ids.push(Number(parsed.args[0]));
    } catch {
      // Not one of ours; Kuru emits vault and fee logs in the same receipt.
    }
  }
  return ids;
}

export { quotesPath };
