/**
 * Deploys Pit.
 *
 *   - collateral: reuses PIT_COLLATERAL if set, otherwise deploys a 6-decimal
 *     faucet token (testnet only — on mainnet point PIT_COLLATERAL at USDC).
 *   - Kuru router: KURU_ROUTER, or the address from packages/core/src/chain.ts,
 *     or a local MockKuruRouter when there is no Kuru on this chain.
 *   - PitFactory, wired to a settler (the CRE workflow's sender) and an
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
  let collateral = process.env.PIT_COLLATERAL?.trim();
  if (!collateral) {
    console.log("PIT_COLLATERAL unset — deploying a faucet USDC for this deployment.");
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Pit USD", "cUSD", 6);
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
  const settler = process.env.PIT_SETTLER?.trim() || deployer.address;
  const operator = process.env.PIT_OPERATOR?.trim() || deployer.address;

  const factory = await (
    await ethers.getContractFactory("PitFactory")
  ).deploy(deployer.address, collateral, kuruRouter, settler, operator);
  await factory.waitForDeployment();
  const pitFactory = await factory.getAddress();
  const startBlock = (await ethers.provider.getBlockNumber()) - 1;

  console.log(`  PitFactory  ${pitFactory}`);
  console.log(`  settler      ${settler}   (set to the CRE Forwarder before going live)`);
  console.log(`  operator     ${operator}`);

  // --- CRE settlement receiver -------------------------------------------
  // The Chainlink Forwarder delivers the DON's signed report here, and this
  // contract is the only thing allowed to call settle. Until a Forwarder address
  // is known we deploy it but leave the factory's settler on the deploy key, so
  // `npm run settle:manual` still works and a demo is never blocked on CRE.
  const creForwarder = process.env.CRE_FORWARDER?.trim();
  const receiverContract = await (
    await ethers.getContractFactory("PitSettlementReceiver")
  ).deploy(deployer.address, pitFactory, creForwarder ?? deployer.address);
  await receiverContract.waitForDeployment();
  const receiver = await receiverContract.getAddress();
  console.log(`  Receiver     ${receiver}`);

  // --- CRE roll receiver --------------------------------------------------
  // The other half of the operating loop. A board of five-minute markets needs
  // somebody to open the next columns every five minutes, and that used to be a
  // script holding the operator key. This contract is the operator instead, and
  // the only thing that can reach it is a report the DON signed.
  const rollContract = await (
    await ethers.getContractFactory("PitRollReceiver")
  ).deploy(deployer.address, pitFactory, creForwarder ?? deployer.address);
  await rollContract.waitForDeployment();
  const rollReceiver = await rollContract.getAddress();
  console.log(`  Roller       ${rollReceiver}`);

  if (creForwarder) {
    await (await factory.setSettler(receiver)).wait();
    await (await factory.setOperator(rollReceiver)).wait();
    console.log(`  forwarder    ${creForwarder}  (settler -> receiver, operator -> roller)`);
  } else {
    // Until a Forwarder exists the deploy key keeps both roles, so
    // `tick:local` and `settle:manual` still work and a demo is never blocked
    // on CRE being live.
    console.log(`  forwarder    unset — settler and operator stay ${deployer.address}`);
    console.log(`               once CRE is deployed: CRE_FORWARDER=0x... and call`);
    console.log(`               receiver.setForwarder(...), roller.setForwarder(...),`);
    console.log(`               factory.setSettler(${receiver}) and factory.setOperator(${rollReceiver})`);
  }

  const deployment: Deployment = {
    chainId,
    network: network.name,
    deployedAt: new Date().toISOString(),
    collateral,
    collateralSymbol: symbol,
    collateralDecimals: decimals,
    kuruRouter,
    pitFactory,
    settlementReceiver: receiver,
    rollReceiver,
    creForwarder: creForwarder ?? null,
    settler: creForwarder ? receiver : settler,
    operator: creForwarder ? rollReceiver : operator,
    startBlock: Math.max(startBlock, 0),
  };
  const file = writeDeployment(deployment);
  console.log(`\nWrote ${file}`);

  console.log("\nPaste into .env:");
  console.log(`PIT_FACTORY=${pitFactory}`);
  console.log(`PIT_COLLATERAL=${collateral}`);
  console.log(`PIT_SETTLEMENT_RECEIVER=${receiver}`);
  console.log(`PIT_ROLL_RECEIVER=${rollReceiver}`);
  console.log(`ENVIO_START_BLOCK=${deployment.startBlock}`);
  console.log(`NEXT_PUBLIC_PIT_FACTORY=${pitFactory}`);
  console.log(`NEXT_PUBLIC_COLLATERAL=${collateral}`);
  console.log("\nNext: npm run windows:roll  then  npm run seed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
