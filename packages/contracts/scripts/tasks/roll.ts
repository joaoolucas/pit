/**
 * Keeps the grid full. The fallback for when the CRE workflow is not the operator.
 *
 * Reads spot, builds the strike ladder around it, and opens every (column, row)
 * cell in the next `columns` five-minute windows that does not exist yet. Safe to
 * run every minute: `findWindow` makes it idempotent, so a re-run costs one
 * static call per cell and nothing else. Once `setOperator` points at
 * PitRollReceiver this reports that and does nothing, which is the correct
 * steady state — the same treatment settlement already has.
 */
import { ethers, network } from "hardhat";

import { fetchSpotE8, nowSeconds, readDeployment, usd } from "../lib";
import {
  DEFAULT_COLUMNS,
  DEFAULT_LADDER_ROWS,
  DEFAULT_LADDER_STEP_BPS,
  ladderStepUsd,
  strikeLadder,
  upcomingWindowEnds,
  WINDOW_SECONDS,
} from "../../../core/src/windows";

export type RollOptions = {
  underlying?: string;
  columns?: number;
  rows?: number;
  stepBps?: number;
  /** One summary line instead of one line per cell. */
  quiet?: boolean;
};

export type RollResult = {
  created: number;
  existing: number;
  spotE8: bigint;
  stepUsd: number;
  /** Null when this signer is not the operator; nothing was attempted. */
  operator: string | null;
};

export async function rollWindows(options: RollOptions = {}): Promise<RollResult> {
  const label = options.underlying ?? process.env.UNDERLYING ?? "BTC-USD";
  const underlying = ethers.keccak256(ethers.toUtf8Bytes(label));

  const columns = options.columns ?? Number(process.env.COLUMNS ?? DEFAULT_COLUMNS);
  const rows = options.rows ?? Number(process.env.ROWS ?? DEFAULT_LADDER_ROWS);
  const stepBps = options.stepBps ?? Number(process.env.STEP_BPS ?? DEFAULT_LADDER_STEP_BPS);

  const deployment = readDeployment();
  const factory = await ethers.getContractAt("PitFactory", deployment.pitFactory);
  const [signer] = await ethers.getSigners();

  const operator = await factory.operator();
  if (operator.toLowerCase() !== signer.address.toLowerCase()) {
    // Not an error in a loop: once CRE owns the operator this is the normal state.
    if (!options.quiet) {
      console.log(
        `${signer.address} is not the operator (${operator}) — leaving the board to whoever is.`,
      );
    }
    return { created: 0, existing: 0, spotE8: 0n, stepUsd: 0, operator: null };
  }

  const spotE8 = await fetchSpotE8(label);
  const now = nowSeconds();
  const ends = upcomingWindowEnds(now, columns);
  const strikes = strikeLadder(spotE8, rows, stepBps);
  const stepUsd = ladderStepUsd(spotE8, stepBps);

  if (!options.quiet) {
    console.log(`${label} spot $${usd(spotE8)} on ${network.name}`);
    console.log(`Grid: ${columns} columns x ${rows} rows, $${stepUsd} apart`);
    console.log(`Roller: ${signer.address}\n`);
  }

  let created = 0;
  let existing = 0;

  for (const endTs of ends) {
    const startTs = endTs - WINDOW_SECONDS;
    for (const strikeE8 of strikes) {
      const [exists] = await factory.findWindow(underlying, endTs, strikeE8);
      if (exists) {
        existing++;
        continue;
      }

      // Opening a cell deploys two ERC20s and two Kuru markets, so send them one
      // at a time and let each confirm — a revert halfway through a batch would
      // leave half a column.
      const tx = await factory.createWindow(underlying, startTs, endTs, strikeE8);
      const receipt = await tx.wait();
      created++;

      if (!options.quiet) {
        const at = new Date(endTs * 1000).toISOString().slice(11, 16);
        console.log(`  + ${at}  $${usd(strikeE8).padStart(10)}  tx ${receipt?.hash}`);
      }
    }
  }

  return { created, existing, spotE8, stepUsd, operator };
}
