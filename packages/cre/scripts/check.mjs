/**
 * Pre-flight for the settlement workflow.
 *
 * `cre workflow simulate` needs the CRE CLI and a funded key. These three checks
 * do not, and they catch the failures that actually happen:
 *
 *   1. abi.ts drifting from the compiled PitFactory
 *   2. config.*.json still pointing at the zero address after a redeploy
 *   3. price parsing losing a cent
 *   4. ladder.ts drifting from @pit/core, which is the one thing that makes
 *      keeping a second copy of the grid geometry acceptable
 *
 * Run it in CI and before every simulate.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseE8, formatE8 } from "../settle-workflow/price.ts";
import { strikeLadder, ladderStepUsd, upcomingWindowEnds, WINDOW_SECONDS } from "../settle-workflow/ladder.ts";
import * as core from "../../core/src/windows.ts";

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

  for (const name of ["pendingSettlement", "missingWindows"]) {
    const onchain = compiled.find((f) => f.type === "function" && f.name === name);
    if (!onchain) {
      fail(`PitFactory no longer has ${name} — the workflow reads it every pass`);
      continue;
    }

    const signature = `${name}(${onchain.inputs.map((i) => i.type).join(",")})`;
    const outputs = onchain.outputs.map((o) => o.type).join(",");
    const declaresName = source.includes(`"${name}"`);
    const declaresInputs = onchain.inputs.every((i) => source.includes(`"${i.type}"`));
    const declaresOutputs = onchain.outputs.every((o) => source.includes(`"${o.type}"`));

    if (declaresName && declaresInputs && declaresOutputs) pass(`abi.ts matches ${signature} -> (${outputs})`);
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
  const zeros = ["pitFactoryAddress", "receiverAddress", "rollReceiverAddress"].filter((key) =>
    /^0x0{40}$/i.test(target[key] ?? ""),
  );

  for (const key of ["columns", "ladderRows", "ladderStepBps", "maxOpensPerReport"]) {
    if (!Number.isInteger(target[key]) || target[key] <= 0) fail(`${file}: ${key} must be a positive integer`);
  }
  if (target.ladderRows % 2 === 0) fail(`${file}: ladderRows must be odd — the middle row is the up/down cell`);

  // CRE's default write cap is 10m (ChainWrite evm_gas). A report over that is
  // dropped by the DON even though it would fit a Monad block (150m).
  const CRE_WRITE_GAS_CAP = 10_000_000n;
  for (const key of ["gasLimit", "rollGasLimit"]) {
    let n = 0n;
    try {
      n = BigInt(target[key] ?? "");
    } catch {
      n = 0n;
    }
    if (n <= 0n) fail(`${file}: ${key} must be a positive integer`);
  }
  const rollGas = BigInt(target.rollGasLimit);
  if (rollGas > CRE_WRITE_GAS_CAP) {
    fail(`${file}: rollGasLimit ${rollGas} exceeds CRE's default write cap (${CRE_WRITE_GAS_CAP})`);
  } else {
    pass(`${file}: rollGasLimit ${target.rollGasLimit} fits CRE's write cap`);
  }

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

// --- 4. the workflow's grid geometry still matches @pit/core --------------
//
// ladder.ts is a hand-kept copy, because a WASM workflow should not drag a
// workspace package into its bundle for four pure functions. This is the price
// of that decision: the copy has to be proved equal, not assumed equal.
try {
  assert.equal(WINDOW_SECONDS, core.WINDOW_SECONDS, "window size");

  const prices = [1n, 900n, 4512n, 65123n, 77364n, 103998n, 250000n];
  for (const usd of prices) {
    const spotE8 = usd * 100000000n;
    assert.equal(ladderStepUsd(spotE8, 5), core.ladderStepUsd(spotE8, 5), `step at $${usd}`);

    for (const rows of [3, 7, 11]) {
      assert.deepEqual(
        strikeLadder(spotE8, rows, 5),
        core.strikeLadder(spotE8, rows, 5),
        `ladder at $${usd} x ${rows}`,
      );
    }
  }

  for (const now of [0, 1, 299, 300, 301, 1788000000]) {
    assert.deepEqual(upcomingWindowEnds(now, 8), core.upcomingWindowEnds(now, 8), `columns from ${now}`);
  }

  pass("ladder.ts agrees with @pit/core on strikes, steps and columns");
} catch (error) {
  fail(`ladder.ts has drifted from @pit/core: ${error.message}`);
}

console.log(failures === 0 ? "\nWorkflow pre-flight passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
