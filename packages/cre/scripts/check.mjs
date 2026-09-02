/**
 * Pre-flight for the settlement workflow.
 *
 * `cre workflow simulate` needs the CRE CLI and a funded key. These three checks
 * do not, and they catch the failures that actually happen:
 *
 *   1. abi.ts drifting from the compiled PitFactory
 *   2. config.*.json still pointing at the zero address after a redeploy
 *   3. price parsing losing a cent
 *
 * Run it in CI and before every simulate.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseE8, formatE8 } from "../settle-workflow/price.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = path.resolve(here, "../settle-workflow");
const artifact = path.resolve(here, "../../contracts/artifacts/contracts/PitFactory.sol/PitFactory.json");

let failures = 0;
const fail = (message) => {
  console.error(`  FAIL  ${message}`);
  failures++;
};
const pass = (message) => console.log(`  ok    ${message}`);

// --- 1. the ABI fragment still matches the contract -----------------------
if (!fs.existsSync(artifact)) {
  console.warn("  skip  PitFactory artifact not found — run: npm --prefix ../contracts run build");
} else {
  const compiled = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
  const source = fs.readFileSync(path.join(workflow, "abi.ts"), "utf8");

  const onchain = compiled.find((f) => f.type === "function" && f.name === "pendingSettlement");
  if (!onchain) {
    fail("PitFactory no longer has pendingSettlement — the workflow's only read is gone");
  } else {
    const signature = `pendingSettlement(${onchain.inputs.map((i) => i.type).join(",")})`;
    const outputs = onchain.outputs.map((o) => o.type).join(",");
    const declaresInputs = onchain.inputs.every((i) => source.includes(`"${i.type}"`));
    const declaresOutput = source.includes(`"${outputs}"`);

    if (declaresInputs && declaresOutput) pass(`abi.ts matches ${signature} -> (${outputs})`);
    else fail(`abi.ts does not match the compiled ${signature} -> (${outputs})`);
  }
}

// --- 2. the configs point somewhere real ----------------------------------
for (const file of ["config.staging.json", "config.production.json"]) {
  const config = JSON.parse(fs.readFileSync(path.join(workflow, file), "utf8"));
  const target = config.evms?.[0];
  if (!target) {
    fail(`${file}: evms[0] is missing`);
    continue;
  }
  const zeros = ["pitFactoryAddress", "receiverAddress"].filter((key) => /^0x0{40}$/i.test(target[key] ?? ""));
  if (zeros.length > 0) {
    console.warn(`  warn  ${file}: ${zeros.join(", ")} still zero — run: npm run sync`);
  } else {
    pass(`${file} points at ${target.chainName}`);
  }
  if (!/^(\*\/\d+|\d+) /.test(config.schedule)) fail(`${file}: schedule "${config.schedule}" looks wrong`);
}

// --- 3. price parsing -----------------------------------------------------
try {
  assert.equal(parseE8("65123.45"), 6_512_345_000_000n);
  assert.equal(parseE8("65123"), 6_512_300_000_000n);
  assert.equal(parseE8("0.00000001"), 1n);
  assert.equal(parseE8(" 1.5 "), 150_000_000n);
  // More precision than we keep is truncated, never rounded up into a settle.
  assert.equal(parseE8("1.234567891"), 123_456_789n);
  assert.throws(() => parseE8("1e5"));
  assert.throws(() => parseE8("-1"));
  assert.equal(formatE8(6_512_345_000_000n), "$65,123.45");
  pass("price parsing keeps every cent and rejects junk");
} catch (error) {
  fail(`price parsing: ${error.message}`);
}

console.log(failures === 0 ? "\nWorkflow pre-flight passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
