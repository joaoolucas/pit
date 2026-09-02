/**
 * One pass of everything that keeps the board alive, and optionally forever.
 *
 * A grid of five-minute markets is not a deploy, it is an operation. Columns
 * close, new ones have to be opened, quotes have to be refreshed against a
 * moving price, and closed windows have to be resolved. Running three scripts by
 * hand works for a screenshot and fails within half an hour, which is exactly
 * what happened the first time this was demoed.
 *
 * Order matters:
 *
 *   1. settle  — resolve closed windows first, so the seeder skips them
 *   2. roll    — open any cell in the next N columns that does not exist
 *   3. seed    — requote every live cell around the current price
 *
 * Each stage is caught on its own. A failing price fetch must not stop
 * settlement, and a single reverting cell must not stop the loop.
 *
 *   npm run tick:local                    one pass
 *   TICK_WATCH=1 npm run tick:local       every 60s until you stop it
 *
 * In production settlement and rolling belong to CRE. Once `setSettler` and
 * `setOperator` point at the receivers, stage 1 reports "not the settler" and
 * stage 2 reports "CRE owns the operator", and both do nothing — which is the
 * correct steady state. Seeding still runs: quoting is a participant, not
 * infrastructure.
 */
import { network } from "hardhat";

import { rollWindows } from "./tasks/roll";
import { seedBooks } from "./tasks/seed";
import { settleClosed } from "./tasks/settle";
import { usd } from "./lib";

// An env var rather than a flag: `hardhat run` owns argv and rejects flags it
// does not know.
const WATCH = process.env.TICK_WATCH === "1" || process.argv.includes("--watch");
const INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 60_000);

const stamp = () => new Date().toTimeString().slice(0, 8);

async function tick(pass: number) {
  const parts: string[] = [];

  try {
    const { settled, failed } = await settleClosed({ quiet: true });
    if (settled > 0) parts.push(`settled ${settled}`);
    if (failed > 0) parts.push(`settle-failed ${failed}`);
  } catch (error) {
    parts.push(`settle error: ${(error as Error).message.slice(0, 60)}`);
  }

  let spot = "";
  try {
    const rolled = await rollWindows({ quiet: true });
    if (rolled.operator === null) {
      parts.push("roll: CRE owns the operator");
    } else {
      spot = `$${usd(rolled.spotE8)} / $${rolled.stepUsd} rows`;
      if (rolled.created > 0) parts.push(`opened ${rolled.created}`);
      parts.push(`${rolled.existing + rolled.created} cells`);
    }
  } catch (error) {
    parts.push(`roll error: ${(error as Error).message.slice(0, 60)}`);
  }

  try {
    const { quoted, skipped } = await seedBooks({ quiet: true });
    parts.push(`quoted ${quoted}`);
    if (skipped > 0) parts.push(`${skipped} out of band`);
  } catch (error) {
    parts.push(`seed error: ${(error as Error).message.slice(0, 60)}`);
  }

  console.log(`${stamp()}  #${pass}  ${spot}  ${parts.join("  ·  ")}`);
}

async function main() {
  console.log(`Pit tick on ${network.name}${WATCH ? ` every ${INTERVAL_MS / 1000}s` : ""}\n`);

  let pass = 1;
  await tick(pass);
  if (!WATCH) return;

  // setInterval would overlap a slow pass with the next one, and a pass that
  // opens 42 cells is not fast. Chain the delay after the work instead.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await tick(++pass);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
