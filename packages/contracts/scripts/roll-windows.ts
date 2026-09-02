/**
 * CLI wrapper. The work is in tasks/roll.ts, so tick.ts can compose it.
 *
 *   COLUMNS=8 ROWS=7 STEP_BPS=5 npm run windows:roll
 */
import { rollWindows } from "./tasks/roll";

rollWindows()
  .then(({ created, existing }) => {
    console.log(`\n${created} opened, ${existing} already live.`);
    if (created > 0) console.log("Next: npm run seed — nothing is tradeable until both sides are quoted.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
