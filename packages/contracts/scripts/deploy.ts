/**
 * Deploys Cell.
 *
 *   - collateral: reuses CELL_COLLATERAL if set, otherwise deploys a 6-decimal
 *     faucet token (testnet only — on mainnet point CELL_COLLATERAL at USDC).
 *   - Kuru router: KURU_ROUTER, or the address from packages/core/src/chain.ts,
 *     or a local MockKuruRouter when there is no Kuru on this chain.
 *   - CellFactory, wired to a settler (the CRE workflow's sender) and an
 *     operator (the window roller).
 *
 * Writes deployments/<network>.json and prints the .env lines to paste.
 */
import { ethers, network } from "hardhat";
import { writeDeployment, type Deployment } from "./lib";
import { CHAINS } from "../../core/src/chain";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Network      ${network.name} (chainId ${chainId})`);
  console.log(`Deployer     ${deployer.address}`);
  console.log(`Balance      ${ethers.formatEther(balance)} MON\n`);
  if (balance === 0n) throw new Error("Deployer has no gas. Fund it at https://faucet.monad.xyz");

  // --- collateral --------------------------------------------------------
  let collateral = process.env.CELL_COLLATERAL?.trim();
  if (!collateral) {
    console.log("CELL_COLLATERAL unset — deploying a faucet USDC for this deployment.");
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Cell USD", "cUSD", 6);
    await token.waitForDeployment();
    collateral = await token.getAddress();
    console.log(`  cUSD         ${collateral}`);
  }
  const token = await ethers.getContractAt("MockERC20", collateral);
  const [symbol, decimals] = [await token.symbol(), Number(await token.decimals())];

  // --- Kuru router -------------------------------------------------------
  let kuruRouter = process.env.KURU_ROUTER?.trim() || CHAINS[chainId]?.kuru.router;
  if (!kuruRouter || (await ethers.provider.getCode(kuruRouter)) === "0x") {
    console.log("No Kuru Router on this chain — deploying MockKuruRouter (local development only).");
    const mock = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    await mock.waitForDeployment();
    kuruRouter = await mock.getAddress();
  }
  console.log(`  Kuru Router  ${kuruRouter}`);

  // --- factory -----------------------------------------------------------
  const settler = process.env.CELL_SETTLER?.trim() || deployer.address;
  const operator = process.env.CELL_OPERATOR?.trim() || deployer.address;

  const factory = await (
    await ethers.getContractFactory("CellFactory")
  ).deploy(deployer.address, collateral, kuruRouter, settler, operator);
  await factory.waitForDeployment();
  const cellFactory = await factory.getAddress();
  const startBlock = (await ethers.provider.getBlockNumber()) - 1;

  console.log(`  CellFactory  ${cellFactory}`);
  console.log(`  settler      ${settler}   (set to the CRE Forwarder before going live)`);
  console.log(`  operator     ${operator}`);

  const deployment: Deployment = {
    chainId,
    network: network.name,
    deployedAt: new Date().toISOString(),
    collateral,
    collateralSymbol: symbol,
    collateralDecimals: decimals,
    kuruRouter,
    cellFactory,
    settler,
    operator,
    startBlock: Math.max(startBlock, 0),
  };
  const file = writeDeployment(deployment);
  console.log(`\nWrote ${file}`);

  console.log("\nPaste into .env:");
  console.log(`CELL_FACTORY=${cellFactory}`);
  console.log(`CELL_COLLATERAL=${collateral}`);
  console.log(`ENVIO_START_BLOCK=${deployment.startBlock}`);
  console.log(`NEXT_PUBLIC_CELL_FACTORY=${cellFactory}`);
  console.log(`NEXT_PUBLIC_COLLATERAL=${collateral}`);
  console.log("\nNext: npm run windows:roll  then  npm run seed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
