/**
 * CLI wrapper. The work is in tasks/settle.ts, so tick.ts can compose it.
 *
 *   npm run settle:manual                 every closed, unresolved window
 *   WINDOW_ID=3 npm run settle:manual     just one
 */
import { settleClosed } from "./tasks/settle";

settleClosed()
  .then(({ settled, failed, settler }) => {
    if (settler === null) return;
    console.log(settled === 0 ? "\nNothing closed and unresolved." : `\n${settled} window(s) settled.`);
    if (failed > 0) console.log(`${failed} could not be settled.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
