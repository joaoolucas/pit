/**
 * Points config.yaml at the latest deployment.
 *
 * The PitFactory address and the chain id live in
 * packages/contracts/deployments/<network>.json, written by the deploy script.
 * Copying them by hand is exactly the kind of thing that silently indexes the
 * wrong contract for an hour, so this does it.
 *
 *   node scripts/sync.mjs                 # monadTestnet
 *   node scripts/sync.mjs localhost
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const network = process.argv[2] ?? "monadTestnet";
const deploymentFile = path.resolve(here, `../../contracts/deployments/${network}.json`);
const configFile = path.resolve(here, "../config.yaml");

if (!fs.existsSync(deploymentFile)) {
  console.error(`No deployment at ${deploymentFile}. Run the deploy script for "${network}" first.`);
  process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
const original = fs.readFileSync(configFile, "utf8");

const updated = original
  .replace(/(chains:\s*\n\s*- id: )\d+/, `$1${deployment.chainId}`)
  .replace(/(start_block: )\d+/, `$1${deployment.startBlock}`)
  .replace(/(- name: PitFactory\n\s*address: ")0x[0-9a-fA-F]{40}(")/, `$1${deployment.pitFactory}$2`);

if (updated === original) {
  console.log("config.yaml already matches the deployment.");
} else {
  fs.writeFileSync(configFile, updated);
  console.log(`config.yaml -> chain ${deployment.chainId}, PitFactory ${deployment.pitFactory}, from block ${deployment.startBlock}`);
}

if (network === "localhost") {
  console.log(
    "\nlocalhost has no HyperSync endpoint. Add an `rpc:` line to the chain block, e.g.\n" +
      "  chains:\n    - id: 31337\n      rpc: http://127.0.0.1:8545\n",
  );
}
