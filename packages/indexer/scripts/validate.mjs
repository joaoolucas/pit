/**
 * Validates config.yaml against the schema that ships inside the envio package,
 * and cross-checks that every event listed there actually exists in the ABI.
 *
 * The envio CLI has no Windows binary, so on Windows `envio codegen` is a Docker
 * or WSL job (see README). This gives you the same failure — a typo in an event
 * signature, a missing ABI, a contract listed on no chain — without a container,
 * and it runs in CI on every push.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(here, "..");

const schema = JSON.parse(fs.readFileSync(require.resolve("envio/evm.schema.json"), "utf8"));
const config = parseYaml(fs.readFileSync(path.join(root, "config.yaml"), "utf8"));

const problems = [];
const warnings = [];

// --- 1. shape -------------------------------------------------------------
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
// The envio schema annotates integers with Rust-ish formats ajv has never heard of.
for (const format of ["uint", "uint32", "uint64"]) ajv.addFormat(format, { type: "number", validate: (n) => Number.isInteger(n) && n >= 0 });
if (!ajv.validate(schema, config)) {
  for (const error of ajv.errors ?? []) {
    problems.push(`config.yaml${error.instancePath} ${error.message}`);
  }
}

// --- 2. every declared event exists in the ABI ----------------------------
const normalise = (signature) =>
  signature
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/, "(")
    .replace(/\s*\)\s*$/, ")")
    .trim();

/** "Trade(uint40 orderId, address maker)" -> "Trade(uint40,address)" */
const canonical = (signature) => {
  const name = signature.slice(0, signature.indexOf("("));
  const args = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const types = args
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.split(/\s+/)[0]);
  return `${name.trim()}(${types.join(",")})`;
};

const abiCanonical = (fragment) =>
  `${fragment.name}(${fragment.inputs.map((i) => i.type).join(",")})`;

for (const contract of config.contracts ?? []) {
  const abiPath = path.join(root, contract.abi_file_path ?? "");
  if (!contract.abi_file_path || !fs.existsSync(abiPath)) {
    problems.push(`${contract.name}: abi_file_path "${contract.abi_file_path}" not found`);
    continue;
  }
  const parsed = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  const abi = Array.isArray(parsed) ? parsed : parsed.abi;
  const events = new Set(abi.filter((f) => f.type === "event").map(abiCanonical));

  for (const entry of contract.events ?? []) {
    const signature = canonical(normalise(entry.event ?? entry));
    if (!events.has(signature)) {
      problems.push(
        `${contract.name}: ${signature} is not in ${contract.abi_file_path}.\n` +
          `    available: ${[...events].join(", ")}`,
      );
    }
  }
}

// --- 3. every contract is wired to a chain --------------------------------
const wired = new Set();
for (const chain of config.chains ?? []) {
  for (const contract of chain.contracts ?? []) wired.add(contract.name);
}
for (const contract of config.contracts ?? []) {
  if (!wired.has(contract.name)) {
    problems.push(`${contract.name} is declared but listed on no chain — it will never be indexed.`);
  }
}

// --- 4. the factory address is real ---------------------------------------
for (const chain of config.chains ?? []) {
  for (const contract of chain.contracts ?? []) {
    if (contract.address && /^0x0{40}$/i.test(contract.address)) {
      warnings.push(`${contract.name} on chain ${chain.id} is still the zero address — run: npm run sync`);
    }
  }
}

for (const warning of warnings) console.warn(`  ! ${warning}`);

if (problems.length > 0) {
  console.error(`config.yaml has ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const eventCount = (config.contracts ?? []).reduce((n, c) => n + (c.events?.length ?? 0), 0);
console.log(
  `config.yaml OK — ${config.contracts.length} contracts, ${eventCount} events, ${config.chains.length} chain(s).`,
);
