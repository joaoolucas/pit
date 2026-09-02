/**
 * Copies the deployed addresses into the workflow configs.
 *
 *   node scripts/sync.mjs                 # monadTestnet -> config.staging.json
 *   node scripts/sync.mjs monadMainnet    # -> config.production.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const network = process.argv[2] ?? "monadTestnet";
const configName = network === "monadMainnet" ? "config.production.json" : "config.staging.json";

const deploymentFile = path.resolve(here, `../../contracts/deployments/${network}.json`);
const configFile = path.resolve(here, `../settle-workflow/${configName}`);

if (!fs.existsSync(deploymentFile)) {
  console.error(`No deployment at ${deploymentFile}. Deploy to "${network}" first.`);
  process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

const target = config.evms[0];
target.pitFactoryAddress = deployment.pitFactory;
target.receiverAddress = deployment.settlementReceiver;
target.rollReceiverAddress = deployment.rollReceiver;

fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${configName} -> factory ${target.pitFactoryAddress}, settle ${target.receiverAddress}, roll ${target.rollReceiverAddress}`);

if (!deployment.creForwarder) {
  console.warn(
    "\nThe deployment has no CRE Forwarder yet, so settler and operator are still the deploy key.\n" +
      "After `cre workflow deploy`, take the Forwarder address for your DON and run:\n" +
      `  receiver.setForwarder(<forwarder>)\n  roller.setForwarder(<forwarder>)\n` +
      `  factory.setSettler(${deployment.settlementReceiver})\n  factory.setOperator(${deployment.rollReceiver})`,
  );
}
