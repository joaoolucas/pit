/**
 * Production-shaped operator for a host that can keep a process alive.
 *
 * Runs the local indexer (GraphQL on PORT) and the tick loop (settle / roll /
 * seed) against the same network. Envio + CRE replace these in the intended
 * steady state; this is the documented fallback that actually keeps a board
 * open today.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hardhat = path.join(cwd, "node_modules", ".bin", "hardhat");
const network = process.env.PIT_NETWORK ?? "monadTestnet";

function run(script, extraEnv = {}) {
  const child = spawn(hardhat, ["run", script, "--network", network], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    console.error(`${script} exited code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  });
}

run("scripts/local-indexer.ts");
run("scripts/tick.ts", { TICK_WATCH: "1" });
