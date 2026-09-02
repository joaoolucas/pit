import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { PitFactory, PitSettlementReceiver, MockERC20, MockKuruRouter } from "../typechain-types";

const BTC_USD = ethers.keccak256(ethers.toUtf8Bytes("BTC-USD"));
const E8 = 100_000_000n;

/** The exact payload the CRE workflow encodes: one price, many windows. */
const encodeReport = (priceE8: bigint, windowIds: bigint[]) =>
  ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256[]"], [priceE8, windowIds]);

describe("PitSettlementReceiver", () => {
  let owner: HardhatEthersSigner;
  let forwarder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let factory: PitFactory;
  let receiver: PitSettlementReceiver;
  let usdc: MockERC20;
  let router: MockKuruRouter;
  let endTs: number;

  const strikes = [64_000n * E8, 65_000n * E8, 66_000n * E8];

  beforeEach(async () => {
    [owner, forwarder, stranger] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    router = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    factory = await (
      await ethers.getContractFactory("PitFactory")
    ).deploy(owner.address, await usdc.getAddress(), await router.getAddress(), owner.address, owner.address);

    receiver = await (
      await ethers.getContractFactory("PitSettlementReceiver")
    ).deploy(owner.address, await factory.getAddress(), forwarder.address);

    // The receiver is the only address allowed to settle.
    await factory.setSettler(await receiver.getAddress());

    const startTs = (await time.latest()) + 10;
    endTs = startTs + 300;
    // A whole column: three strikes closing at the same instant.
    for (const strike of strikes) {
      await factory.createWindow(BTC_USD, startTs, endTs, strike);
    }
  });

  it("advertises IReceiver over ERC-165 so the Forwarder will accept it", async () => {
    // onReport(bytes,bytes) — the only function in IReceiver beyond ERC-165.
    const onReportSelector = ethers.id("onReport(bytes,bytes)").slice(0, 10);
    expect(await receiver.supportsInterface(onReportSelector)).to.equal(true);
    expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await receiver.supportsInterface("0xdeadbeef")).to.equal(false);
  });

  it("only the forwarder can deliver a report", async () => {
    await time.increaseTo(endTs + 1);
    await expect(
      receiver.connect(stranger).onReport("0x", encodeReport(65_500n * E8, [0n])),
    ).to.be.revertedWithCustomError(receiver, "NotForwarder");
  });

  it("settles a whole column from one report", async () => {
    await time.increaseTo(endTs + 1);
    const priceE8 = 65_500n * E8;

    await expect(receiver.connect(forwarder).onReport("0x", encodeReport(priceE8, [0n, 1n, 2n])))
      .to.emit(receiver, "ReportAccepted")
      .withArgs(priceE8, 3n, (ts: bigint) => ts > 0n);

    // 65,500 is above 64,000 and 65,000 but below 66,000.
    expect((await factory.getWindow(0)).outcome).to.equal(1n); // YES
    expect((await factory.getWindow(1)).outcome).to.equal(1n); // YES
    expect((await factory.getWindow(2)).outcome).to.equal(2n); // NO
    expect(await receiver.lastPriceE8()).to.equal(priceE8);
  });

  it("skips a window that cannot settle instead of dropping the batch", async () => {
    await time.increaseTo(endTs + 1);

    // Simulate the race the workflow will actually hit: someone settled #1 first.
    await factory.setSettler(owner.address);
    await factory.settle(1, 65_500n * E8);
    await factory.setSettler(await receiver.getAddress());

    const tx = receiver.connect(forwarder).onReport("0x", encodeReport(65_500n * E8, [0n, 1n, 2n]));
    await expect(tx).to.emit(receiver, "WindowSkipped");
    await expect(tx).to.emit(receiver, "WindowSettled").withArgs(0n, 65_500n * E8);

    // The two that could settle, did.
    expect((await factory.getWindow(0)).outcome).to.equal(1n);
    expect((await factory.getWindow(2)).outcome).to.equal(2n);
  });

  it("rejects a report with no price or no windows", async () => {
    await time.increaseTo(endTs + 1);
    await expect(receiver.connect(forwarder).onReport("0x", encodeReport(0n, [0n]))).to.be.revertedWithCustomError(
      receiver,
      "BadPrice",
    );
    await expect(
      receiver.connect(forwarder).onReport("0x", encodeReport(65_500n * E8, [])),
    ).to.be.revertedWithCustomError(receiver, "EmptyReport");
  });

  it("lets the owner rotate the forwarder", async () => {
    await expect(receiver.setForwarder(stranger.address))
      .to.emit(receiver, "ForwarderUpdated")
      .withArgs(forwarder.address, stranger.address);
    await expect(receiver.connect(stranger).setForwarder(forwarder.address)).to.be.revertedWithCustomError(
      receiver,
      "OwnableUnauthorizedAccount",
    );
  });
});
