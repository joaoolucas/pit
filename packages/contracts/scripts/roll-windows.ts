/**
 * Keeps the grid full.
 *
 * Reads spot, builds the strike ladder around it, and opens every (column, row)
 * cell in the next `COLUMNS` five-minute windows that does not exist yet. Safe to
 * run on a cron every minute: `findWindow` makes it idempotent, so re-running it
 * costs one static call per cell and nothing else.
 *
 *   COLUMNS=8 LADDER_BPS=30,20,10,0,-10,-20,-30 npm run windows:roll
 */
import { ethers, network } from "hardhat";
import { fetchSpotE8, nowSeconds, readDeployment, usd } from "./lib";
import {
  DEFAULT_COLUMNS,
  DEFAULT_LADDER_BPS,
  strikeLadder,
  upcomingWindowEnds,
  WINDOW_SECONDS,
} from "../../core/src/windows";

const UNDERLYING_LABEL = process.env.UNDERLYING ?? "BTC-USD";
const UNDERLYING = ethers.keccak256(ethers.toUtf8Bytes(UNDERLYING_LABEL));

async function main() {
  const deployment = readDeployment();
  const factory = await ethers.getContractAt("CellFactory", deployment.cellFactory);
  const [signer] = await ethers.getSigners();

  const columns = Number(process.env.COLUMNS ?? DEFAULT_COLUMNS);
  const ladderBps = process.env.LADDER_BPS
    ? process.env.LADDER_BPS.split(",").map((s) => Number(s.trim()))
    : [...DEFAULT_LADDER_BPS];

  const spotE8 = await fetchSpotE8(UNDERLYING_LABEL);
  const now = nowSeconds();
  const ends = upcomingWindowEnds(now, columns);
  const strikes = strikeLadder(spotE8, ladderBps);

  console.log(`${UNDERLYING_LABEL} spot $${usd(spotE8)} on ${network.name}`);
  console.log(`Grid: ${columns} columns x ${strikes.length} rows`);
  console.log(`Roller: ${signer.address}\n`);

  let created = 0;
  let existing = 0;

  for (const endTs of ends) {
    const startTs = endTs - WINDOW_SECONDS;
    for (const strikeE8 of strikes) {
      const [exists] = await factory.findWindow(UNDERLYING, endTs, strikeE8);
      if (exists) {
        existing++;
        continue;
      }

      // Opening a cell deploys two ERC20s and two Kuru markets, so send them one
      // at a time and let each confirm — a revert halfway through a batch would
      // leave half a column.
      const tx = await factory.createWindow(UNDERLYING, startTs, endTs, strikeE8);
      const receipt = await tx.wait();
      created++;

      const label = new Date(endTs * 1000).toISOString().slice(11, 16);
      console.log(`  + ${label}  $${usd(strikeE8).padStart(10)}  tx ${receipt?.hash}`);
    }
  }

  console.log(`\n${created} opened, ${existing} already live.`);
  if (created > 0) console.log("Next: npm run seed  — nothing is tradeable until both sides are quoted.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
