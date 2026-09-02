/**
 * Manual settle — the fallback for when the CRE workflow is not deployed yet.
 *
 * The production path is packages/cre: a Chainlink CRE workflow reads the price
 * API and the window clock, then calls `settle`. This does the same thing with a
 * local key so a demo can be driven from one terminal, and so the escape hatch
 * (`voidWindow`) never has to be the thing that resolves it.
 */
import { ethers } from "hardhat";

import { allWindows, fetchSpotE8, nowSeconds, readDeployment, usd } from "../lib";

export type SettleOptions = {
  underlying?: string;
  /** Settle only this window. */
  windowId?: number | null;
  /** Cap per pass, so one run cannot spend an unbounded amount of gas. */
  max?: number;
  quiet?: boolean;
};

export type SettleResult = {
  settled: number;
  /** Windows that were due but could not be settled — usually not our key. */
  failed: number;
  priceE8: bigint;
  /** Null when this signer is not the settler; nothing was attempted. */
  settler: string | null;
};

export async function settleClosed(options: SettleOptions = {}): Promise<SettleResult> {
  const label = options.underlying ?? process.env.UNDERLYING ?? "BTC-USD";
  const only = options.windowId ?? (process.env.WINDOW_ID ? Number(process.env.WINDOW_ID) : null);
  const max = options.max ?? Number(process.env.MAX_SETTLE ?? 200);

  const deployment = readDeployment();
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("PitFactory", deployment.pitFactory);

  const settler = await factory.settler();
  if (settler.toLowerCase() !== signer.address.toLowerCase()) {
    // Not an error in a loop: once CRE owns settlement this is the normal state.
    if (!options.quiet) {
      console.log(
        `${signer.address} is not the settler (${settler}) — leaving settlement to whoever is.`,
      );
    }
    return { settled: 0, failed: 0, priceE8: 0n, settler: null };
  }

  const priceE8 = await fetchSpotE8(label);
  const now = nowSeconds();
  if (!options.quiet) console.log(`Reference price $${usd(priceE8)}\n`);

  const windows = await allWindows(factory);

  let settled = 0;
  let failed = 0;

  for (let windowId = 0; windowId < windows.length && settled < max; windowId++) {
    if (only !== null && windowId !== only) continue;
    const w = windows[windowId]!;
    if (w.outcome !== 0n) continue;
    if (Number(w.endTs) > now) continue;

    try {
      const tx = await factory.settle(windowId, priceE8);
      await tx.wait();
      settled++;
      if (!options.quiet) {
        const outcome = priceE8 > w.strikeE8 ? "YES" : "NO";
        console.log(`  #${windowId}  strike $${usd(w.strikeE8)}  ->  ${outcome}   tx ${tx.hash}`);
      }
    } catch (error) {
      // A window someone else just settled must not stop the rest.
      failed++;
      if (!options.quiet) console.warn(`  #${windowId} skipped: ${(error as Error).message.slice(0, 80)}`);
    }
  }

  return { settled, failed, priceE8, settler };
}
