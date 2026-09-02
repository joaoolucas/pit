/**
 * CLI wrapper. The work is in tasks/seed.ts, so tick.ts can compose it.
 *
 *   SIZE=200 SPREAD_BPS=200 npm run seed
 */
import { seedBooks, quotesPath } from "./tasks/seed";

seedBooks()
  .then(({ quoted }) => {
    console.log(`\n${quoted} books quoted. Order ids saved to ${quotesPath()}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
