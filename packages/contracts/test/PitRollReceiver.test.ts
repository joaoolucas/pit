import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { PitFactory, PitRollReceiver, MockERC20, MockKuruRouter } from "../typechain-types";

const BTC_USD = ethers.keccak256(ethers.toUtf8Bytes("BTC-USD"));
const E8 = 100_000_000n;
const WINDOW = 300n;

/** The exact payload the CRE workflow encodes: one grid, already filtered. */
const encodeReport = (underlying: string, windowSeconds: bigint, ends: bigint[], strikes: bigint[]) =>
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint64", "uint64[]", "uint256[]"],
    [underlying, windowSeconds, ends, strikes],
  );

describe("PitRollReceiver", () => {
  let owner: HardhatEthersSigner;
  let forwarder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let factory: PitFactory;
  let receiver: PitRollReceiver;
  let usdc: MockERC20;
  let router: MockKuruRouter;

  /** Two columns ahead of now, three rows. */
  let ends: bigint[];
  const strikes = [64_000n * E8, 65_000n * E8, 66_000n * E8];

  beforeEach(async () => {
    [owner, forwarder, stranger] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    router = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    factory = await (
      await ethers.getContractFactory("PitFactory")
    ).deploy(owner.address, await usdc.getAddress(), await router.getAddress(), owner.address, owner.address);

    receiver = await (
      await ethers.getContractFactory("PitRollReceiver")
    ).deploy(owner.address, await factory.getAddress(), forwarder.address);

    // The receiver is the only address allowed to open a window. This is the
    // whole point: no key on a laptop can roll the board.
    await factory.setOperator(await receiver.getAddress());

    const now = BigInt(await time.latest());
    const first = ((now / WINDOW) + 1n) * WINDOW;
    ends = [first, first + WINDOW];
  });

  it("advertises IReceiver over ERC-165 so the Forwarder will accept it", async () => {
    const onReportSelector = ethers.id("onReport(bytes,bytes)").slice(0, 10);
    expect(await receiver.supportsInterface(onReportSelector)).to.equal(true);
    expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await receiver.supportsInterface("0xdeadbeef")).to.equal(false);
  });

  it("only the forwarder can deliver a report", async () => {
    await expect(
      receiver.connect(stranger).onReport("0x", encodeReport(BTC_USD, WINDOW, [ends[0]!], [strikes[0]!])),
    ).to.be.revertedWithCustomError(receiver, "NotForwarder");
  });

  it("opens a whole column from one report", async () => {
    const column = [ends[0]!, ends[0]!, ends[0]!];

    await expect(receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, column, strikes)))
      .to.emit(receiver, "ReportAccepted")
      .withArgs(BTC_USD, 3n, (ts: bigint) => ts > 0n);

    expect(await factory.windowCount()).to.equal(3n);
    expect(await receiver.totalOpened()).to.equal(3n);

    for (let i = 0; i < strikes.length; i++) {
      const [exists, windowId] = await factory.findWindow(BTC_USD, ends[0]!, strikes[i]!);
      expect(exists).to.equal(true);
      const w = await factory.getWindow(windowId);
      expect(w.endTs).to.equal(ends[0]!);
      expect(w.startTs).to.equal(ends[0]! - WINDOW);
      expect(w.strikeE8).to.equal(strikes[i]!);
    }
  });

  it("skips a cell that already exists instead of dropping the batch", async () => {
    // The race the workflow will actually hit: the chain moved between the
    // `missingWindows` read and the report landing.
    await factory.setOperator(owner.address);
    await factory.createWindow(BTC_USD, ends[0]! - WINDOW, ends[0]!, strikes[1]!);
    await factory.setOperator(await receiver.getAddress());

    const column = [ends[0]!, ends[0]!, ends[0]!];
    const tx = receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, column, strikes));

    await expect(tx).to.emit(receiver, "WindowSkipped");
    await expect(tx).to.emit(receiver, "WindowOpened");

    // The two that could open, did — three cells exist, not one.
    expect(await factory.windowCount()).to.equal(3n);
    expect(await receiver.totalOpened()).to.equal(2n);
  });

  it("refuses to open a column that has already closed", async () => {
    const past = BigInt(await time.latest()) - 10n;

    await expect(receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, [past], [strikes[0]!])))
      .to.emit(receiver, "WindowSkipped")
      .withArgs(past, strikes[0]!, "0x");

    expect(await factory.windowCount()).to.equal(0n);
  });

  it("rejects a malformed report", async () => {
    await expect(
      receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, [], [])),
    ).to.be.revertedWithCustomError(receiver, "EmptyReport");

    await expect(
      receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, [ends[0]!], strikes)),
    ).to.be.revertedWithCustomError(receiver, "LengthMismatch");

    await expect(
      receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, 0n, [ends[0]!], [strikes[0]!])),
    ).to.be.revertedWithCustomError(receiver, "BadWindowSeconds");
  });

  it("cannot settle — it only ever opens", async () => {
    // The blast radius claim in the contract doc, asserted: this receiver is the
    // operator, not the settler, so a compromised roll workflow cannot resolve
    // anybody's position.
    expect(await factory.settler()).to.equal(owner.address);
    expect(await factory.operator()).to.equal(await receiver.getAddress());
  });

  it("lets the owner rotate the forwarder", async () => {
    await expect(receiver.setForwarder(stranger.address))
      .to.emit(receiver, "ForwarderUpdated")
      .withArgs(forwarder.address, stranger.address);

    await expect(
      receiver.connect(forwarder).onReport("0x", encodeReport(BTC_USD, WINDOW, [ends[0]!], [strikes[0]!])),
    ).to.be.revertedWithCustomError(receiver, "NotForwarder");
  });

  it("sizes rollGasLimit from a real report, not a guess", async () => {
    // Opening a cell deploys two ERC20s and two Kuru markets. The CRE report's
    // gas limit is maxOpensPerReport of those, plus headroom, and has to fit a
    // Monad block (150m, measured on testnet and mainnet). Too low and every
    // roll report fails silently; too high and it may not fit a block.
    //
    // Measured here: 1 cell ~4.01m, 4 cells ~15.57m. Two OutcomeTokens are
    // 1.20m of that (real bytecode). Two MockKuruOrderBooks are 2.81m — a
    // ceiling, because Kuru lists with a proxy. Keep `rollGasLimit` in the
    // CRE configs in lockstep with ROLL_GAS_LIMIT below.
    const oneTx = await receiver
      .connect(forwarder)
      .onReport("0x", encodeReport(BTC_USD, WINDOW, [ends[0]!], [strikes[0]!]));
    const oneGas = (await oneTx.wait())!.gasUsed;

    const fourEnds = [ends[1]!, ends[1]!, ends[1]!, ends[1]!];
    const fourStrikes = [64_000n, 65_000n, 66_000n, 67_000n].map((s) => s * E8);
    const fourTx = await receiver
      .connect(forwarder)
      .onReport("0x", encodeReport(BTC_USD, WINDOW, fourEnds, fourStrikes));
    const fourGas = (await fourTx.wait())!.gasUsed;

    const ROLL_GAS_LIMIT = 20_000_000n; // 4 × ~4.0m, plus a quarter of headroom
    const MONAD_BLOCK_GAS = 150_000_000n;

    expect(fourGas).to.be.gt(oneGas);
    expect((fourGas * 125n) / 100n).to.be.lte(ROLL_GAS_LIMIT);
    expect(ROLL_GAS_LIMIT).to.be.lt(MONAD_BLOCK_GAS);
  });
});

describe("PitFactory.missingWindows", () => {
  let owner: HardhatEthersSigner;
  let factory: PitFactory;
  let ends: bigint[];
  const strikes = [64_000n * E8, 65_000n * E8, 66_000n * E8];

  beforeEach(async () => {
    [owner] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const router = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    factory = await (
      await ethers.getContractFactory("PitFactory")
    ).deploy(owner!.address, await usdc.getAddress(), await router.getAddress(), owner!.address, owner!.address);

    const now = BigInt(await time.latest());
    const first = ((now / WINDOW) + 1n) * WINDOW;
    ends = [first, first + WINDOW];
  });

  it("returns the whole grid when nothing has been opened", async () => {
    const [outEnds, outStrikes] = await factory.missingWindows(BTC_USD, ends, strikes, 100n);
    expect(outEnds.length).to.equal(6n); // 2 columns x 3 rows
    expect(outStrikes.length).to.equal(6n);
  });

  it("leaves out the cells that exist", async () => {
    await factory.createWindow(BTC_USD, ends[0]! - WINDOW, ends[0]!, strikes[0]!);
    await factory.createWindow(BTC_USD, ends[1]! - WINDOW, ends[1]!, strikes[2]!);

    const [outEnds, outStrikes] = await factory.missingWindows(BTC_USD, ends, strikes, 100n);
    expect(outEnds.length).to.equal(4n);

    for (let i = 0; i < outEnds.length; i++) {
      const [exists] = await factory.findWindow(BTC_USD, outEnds[i]!, outStrikes[i]!);
      expect(exists).to.equal(false);
    }
  });

  it("caps the answer, because the cap is what bounds the report's gas", async () => {
    const [outEnds, outStrikes] = await factory.missingWindows(BTC_USD, ends, strikes, 2n);
    expect(outEnds.length).to.equal(2n);
    expect(outStrikes.length).to.equal(2n);
  });

  it("never asks for a column that has already closed", async () => {
    const past = BigInt(await time.latest()) - 10n;
    const [outEnds] = await factory.missingWindows(BTC_USD, [past, ends[0]!], strikes, 100n);

    expect(outEnds.length).to.equal(3n); // only the live column's three rows
    for (const end of outEnds) expect(end).to.equal(ends[0]!);
  });
});
