/**
 * Takes liquidity, so there is a tape a judge can replay.
 *
 * The seeding script quotes both sides of every cell; this one is the other
 * half of the demo — a taker that walks up to the near-the-money cells and
 * lifts the offer, then prints every transaction hash it produced.
 *
 * Nothing about it is special-cased: it sends `addBuyOrder` to the same Kuru
 * market the UI sends to, from a second signer, and the fills land in the
 * indexer through the same Trade event the deployed indexer reads.
 *
 *   FILLS=4 CONTRACTS=25 npm run demo:fills
 */
import { ethers, network } from "hardhat";
import type { ContractTransactionReceipt, Interface } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { MockERC20 } from "../typechain-types";

import { fetchSpotE8, nowSeconds, readDeployment, usd } from "./lib";
import { contractsToSize, tickToProb } from "../../core/src/kuru";

/** How many cells to trade. */
const FILLS = Number(process.env.FILLS ?? 4);
/** Contracts per fill. Small on purpose: this is a tape, not a position. */
const CONTRACTS = Number(process.env.CONTRACTS ?? 25);

async function main() {
  const deployment = readDeployment();
  const signers = await ethers.getSigners();
  // Prefer a different account from the maker, so the tape has two sides.
  const taker = signers[1] ?? signers[0]!;

  const factory = await ethers.getContractAt("PitFactory", deployment.pitFactory);
  const collateral = await ethers.getContractAt("MockERC20", deployment.collateral);
  const spotE8 = await fetchSpotE8(process.env.UNDERLYING ?? "BTC-USD");
  const now = nowSeconds();

  console.log(`Taker  ${taker.address} on ${network.name}`);
  console.log(`Spot   $${usd(spotE8)}\n`);

  const total = Number(await factory.windowCount());
  const windows = await factory.getWindows(0, total);

  // The cells worth trading are the live ones nearest the money: a book at 0.03
  // has nothing to lift that anyone would want.
  const candidates = windows
    .map((w, windowId) => ({ w, windowId }))
    .filter(({ w }) => w.outcome === 0n && Number(w.endTs) > now + 45)
    .sort((a, b) => {
      const da = a.w.strikeE8 > spotE8 ? a.w.strikeE8 - spotE8 : spotE8 - a.w.strikeE8;
      const db = b.w.strikeE8 > spotE8 ? b.w.strikeE8 - spotE8 : spotE8 - b.w.strikeE8;
      return da < db ? -1 : da > db ? 1 : Number(a.w.endTs - b.w.endTs);
    });

  if (candidates.length === 0) {
    console.log("No live windows. Run: npm run windows:roll && npm run seed");
    return;
  }

  await topUp(collateral, taker.address, deployment.collateralDecimals);

  const receipts: { label: string; hash: string; price: number }[] = [];

  for (const { w, windowId } of candidates.slice(0, FILLS)) {
    const book = await ethers.getContractAt("IKuruOrderBook", w.yesMarket);
    const [, ask] = await book.bestBidAsk();
    if (ask === 0n) {
      console.log(`  · window ${windowId} has no offer — skipped`);
      continue;
    }

    await approve(collateral, taker, w.yesMarket);

    // Cross into the offer with a marketable limit. postOnly false, obviously.
    const size = contractsToSize(CONTRACTS);
    const tx = await book.connect(taker).addBuyOrder(Number(ask), size, false);
    const receipt = (await tx.wait()) as ContractTransactionReceipt;

    const filled = countTrades(book.interface, receipt);
    const label = `${new Date(Number(w.endTs) * 1000).toISOString().slice(11, 16)} $${usd(w.strikeE8)}`;
    receipts.push({ label, hash: receipt.hash, price: tickToProb(ask) });

    console.log(
      `  + ${label}  bought ${CONTRACTS} YES @ ${tickToProb(ask).toFixed(3)}  ` +
        `(${filled} trade${filled === 1 ? "" : "s"})  ${receipt.hash}`,
    );
  }

  if (receipts.length === 0) {
    console.log("\nNothing filled. Is the book seeded?");
    return;
  }

  const risked = receipts.reduce((sum, r) => sum + r.price * CONTRACTS, 0);
  console.log(`\n${receipts.length} fill(s). Risked ${risked.toFixed(2)} for ${receipts.length * CONTRACTS} of max payout.`);
  console.log("Replay them in the explorer, or watch the tape in the app.");
}

async function topUp(collateral: MockERC20, who: string, decimals: number) {
  const floor = 10_000n * 10n ** BigInt(decimals);
  if (((await collateral.balanceOf(who)) as bigint) >= floor) return;
  try {
    await (await collateral.mint(who, floor)).wait();
  } catch {
    console.warn("Collateral has no faucet — fund the taker before running this.");
  }
}

async function approve(collateral: MockERC20, taker: HardhatEthersSigner, spender: string) {
  const allowance = (await collateral.allowance(taker.address, spender)) as bigint;
  if (allowance > ethers.MaxUint256 / 2n) return;
  await (await collateral.connect(taker).approve(spender, ethers.MaxUint256)).wait();
}

function countTrades(iface: Interface, receipt: ContractTransactionReceipt): number {
  let trades = 0;
  for (const log of receipt.logs) {
    try {
      if (iface.parseLog({ topics: [...log.topics], data: log.data })?.name === "Trade") trades++;
    } catch {
      // Other contracts' logs in the same receipt.
    }
  }
  return trades;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
