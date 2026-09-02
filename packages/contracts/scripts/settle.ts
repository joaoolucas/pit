/**
 * Manual settle — the fallback for when the CRE workflow is not deployed yet.
 *
 * The production path is packages/cre: a Chainlink CRE workflow reads the price
 * API and the window clock, then calls `settle`. This script does the same thing
 * with a local key so a judge can drive the whole loop from one terminal, and so
 * the escape hatch (`voidWindow`) never has to be the thing that resolves a demo.
 *
 *   npm run settle:manual                 # settle every closed, unresolved window
 *   WINDOW_ID=3 npm run settle:manual     # just one
 */
import { ethers } from "hardhat";
import { fetchSpotE8, nowSeconds, readDeployment, usd } from "./lib";

async function main() {
  const deployment = readDeployment();
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CellFactory", deployment.cellFactory);

  const settler = await factory.settler();
  if (settler.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `${signer.address} is not the settler (${settler}). ` +
        `Either use the settler key or call setSettler as the owner.`,
    );
  }

  const priceE8 = await fetchSpotE8(process.env.UNDERLYING ?? "BTC-USD");
  const now = nowSeconds();
  console.log(`Reference price $${usd(priceE8)}\n`);

  const only = process.env.WINDOW_ID ? Number(process.env.WINDOW_ID) : null;
  const total = Number(await factory.windowCount());
  const windows = await factory.getWindows(0, total);

  let settled = 0;
  for (let windowId = 0; windowId < windows.length; windowId++) {
    if (only !== null && windowId !== only) continue;
    const w = windows[windowId]!;
    if (w.outcome !== 0n) continue;
    if (Number(w.endTs) > now) continue;

    const outcome = priceE8 > w.strikeE8 ? "YES" : "NO";
    const tx = await factory.settle(windowId, priceE8);
    await tx.wait();
    settled++;
    console.log(`  #${windowId}  strike $${usd(w.strikeE8)}  ->  ${outcome}   tx ${tx.hash}`);
  }

  console.log(settled === 0 ? "\nNothing closed and unresolved." : `\n${settled} window(s) settled.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
