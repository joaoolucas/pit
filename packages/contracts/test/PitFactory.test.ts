import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { PitFactory, MockERC20, MockKuruOrderBook, MockKuruRouter } from "../typechain-types";

const BTC_USD = ethers.keccak256(ethers.toUtf8Bytes("BTC-USD"));
const E8 = 100_000_000n; // price scale
const USD = 1_000_000n; // collateral scale (6 decimals)

const SIZE_PRECISION = 1_000_000n;
const PRICE_PRECISION = 1_000_000n;

/** Contracts, expressed the way a trader says them: "100 contracts". */
const contracts = (n: number | bigint) => BigInt(n) * SIZE_PRECISION;
/** Probability as a Kuru price tick: 0.42 -> 420000. */
const prob = (p: number) => BigInt(Math.round(p * Number(PRICE_PRECISION)));

describe("PitFactory", () => {
  let owner: HardhatEthersSigner;
  let settler: HardhatEthersSigner;
  let maker: HardhatEthersSigner;
  let taker: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let usdc: MockERC20;
  let router: MockKuruRouter;
  let factory: PitFactory;

  let startTs: number;
  let endTs: number;
  const strikeE8 = 65_000n * E8;

  beforeEach(async () => {
    [owner, settler, maker, taker, stranger] = await ethers.getSigners();

    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    router = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    factory = await (
      await ethers.getContractFactory("PitFactory")
    ).deploy(owner.address, await usdc.getAddress(), await router.getAddress(), settler.address, owner.address);

    for (const who of [maker, taker, stranger]) {
      await usdc.mint(who.address, 1_000_000n * USD);
      await usdc.connect(who).approve(await factory.getAddress(), ethers.MaxUint256);
    }

    startTs = (await time.latest()) + 10;
    endTs = startTs + 300; // a 5-minute window
  });

  const openWindow = async () => {
    await factory.createWindow(BTC_USD, startTs, endTs, strikeE8);
    return factory.getWindow(0);
  };

  describe("issuance", () => {
    it("lists both legs on Kuru and records the window", async () => {
      await expect(factory.createWindow(BTC_USD, startTs, endTs, strikeE8))
        .to.emit(factory, "WindowCreated")
        .withArgs(0n, BTC_USD, startTs, endTs, strikeE8, anyAddress, anyAddress, anyAddress, anyAddress);

      const w = await factory.getWindow(0);
      expect(await router.marketCount()).to.equal(2n);
      expect(w.yesMarket).to.not.equal(ethers.ZeroAddress);
      expect(w.noMarket).to.not.equal(ethers.ZeroAddress);
      expect(w.yesMarket).to.not.equal(w.noMarket);

      const yes = await ethers.getContractAt("OutcomeToken", w.yes);
      expect(await yes.decimals()).to.equal(6);
      expect(await yes.symbol()).to.equal("cYES0");
      expect(await yes.windowId()).to.equal(0n);
    });

    it("quotes each leg against the collateral token", async () => {
      const w = await openWindow();
      const yesBook = (await ethers.getContractAt("MockKuruOrderBook", w.yesMarket)) as MockKuruOrderBook;
      expect(await yesBook.baseAsset()).to.equal(w.yes);
      expect(await yesBook.quoteAsset()).to.equal(await usdc.getAddress());
    });

    it("refuses a duplicate window and finds an existing one", async () => {
      await openWindow();
      await expect(factory.createWindow(BTC_USD, startTs, endTs, strikeE8)).to.be.revertedWithCustomError(
        factory,
        "WindowExists",
      );

      const [exists, id] = await factory.findWindow(BTC_USD, endTs, strikeE8);
      expect(exists).to.equal(true);
      expect(id).to.equal(0n);

      const [missing] = await factory.findWindow(BTC_USD, endTs + 300, strikeE8);
      expect(missing).to.equal(false);
    });

    it("lets anyone list a window", async () => {
      await expect(factory.connect(stranger).createWindow(BTC_USD, startTs, endTs, strikeE8))
        .to.emit(factory, "WindowCreated")
        .withArgs(0n, BTC_USD, startTs, endTs, strikeE8, anyAddress, anyAddress, anyAddress, anyAddress);
    });

    it("clones legs so two windows do not share supply", async () => {
      await factory.createWindow(BTC_USD, startTs, endTs, strikeE8);
      await factory.createWindow(BTC_USD, startTs, endTs + 300, strikeE8);
      const w0 = await factory.getWindow(0);
      const w1 = await factory.getWindow(1);
      expect(w0.yes).to.not.equal(w1.yes);

      const yes0 = await ethers.getContractAt("OutcomeToken", w0.yes);
      const yes1 = await ethers.getContractAt("OutcomeToken", w1.yes);
      await factory.connect(maker).mintSet(0, 1_000n * USD);
      expect(await yes0.totalSupply()).to.equal(1_000n * USD);
      expect(await yes1.totalSupply()).to.equal(0);
      expect(await yes0.controller()).to.equal(await factory.getAddress());
    });

    it("mints and burns sets 1:1 and stays fully collateralised", async () => {
      const w = await openWindow();
      const yes = await ethers.getContractAt("OutcomeToken", w.yes);
      const no = await ethers.getContractAt("OutcomeToken", w.no);

      await factory.connect(maker).mintSet(0, 1_000n * USD);
      expect(await yes.balanceOf(maker.address)).to.equal(1_000n * USD);
      expect(await no.balanceOf(maker.address)).to.equal(1_000n * USD);
      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(1_000n * USD);
      expect((await factory.getWindow(0)).collateral).to.equal(1_000n * USD);

      await factory.connect(maker).burnSet(0, 400n * USD);
      expect(await yes.balanceOf(maker.address)).to.equal(600n * USD);
      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(600n * USD);

      // The invariant a trader actually cares about.
      expect(await yes.totalSupply()).to.equal(await no.totalSupply());
      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(await yes.totalSupply());
    });
  });

  describe("settlement", () => {
    beforeEach(async () => {
      await openWindow();
      await factory.connect(maker).mintSet(0, 1_000n * USD);
    });

    it("only the settler can settle, and only after the window closes", async () => {
      await time.increaseTo(endTs + 1);
      await expect(factory.connect(stranger).settle(0, strikeE8 + E8)).to.be.revertedWithCustomError(
        factory,
        "NotSettler",
      );
    });

    it("rejects an early settle", async () => {
      await expect(factory.connect(settler).settle(0, strikeE8 + E8)).to.be.revertedWithCustomError(
        factory,
        "WindowNotClosed",
      );
    });

    it("settles YES above the strike and pays the winner 1:1", async () => {
      await time.increaseTo(endTs + 1);
      await expect(factory.connect(settler).settle(0, strikeE8 + E8))
        .to.emit(factory, "WindowSettled")
        .withArgs(0n, 1n, strikeE8 + E8, anyUint);

      const w = await factory.getWindow(0);
      const yes = await ethers.getContractAt("OutcomeToken", w.yes);
      const no = await ethers.getContractAt("OutcomeToken", w.no);

      // The maker holds a full set, so the payout is exactly what was locked.
      const before = await usdc.balanceOf(maker.address);
      await factory.connect(maker).redeem(0);
      expect((await usdc.balanceOf(maker.address)) - before).to.equal(1_000n * USD);
      expect(await yes.balanceOf(maker.address)).to.equal(0n);
      expect(await no.balanceOf(maker.address)).to.equal(0n);
      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(0n);
    });

    it("settles NO at or below the strike", async () => {
      await time.increaseTo(endTs + 1);
      await factory.connect(settler).settle(0, strikeE8); // exactly at the strike is NO
      expect((await factory.getWindow(0)).outcome).to.equal(2n);
    });

    it("cannot be settled twice", async () => {
      await time.increaseTo(endTs + 1);
      await factory.connect(settler).settle(0, strikeE8 + E8);
      await expect(factory.connect(settler).settle(0, strikeE8 + E8)).to.be.revertedWithCustomError(
        factory,
        "AlreadyResolved",
      );
    });

    it("lets anyone void a stuck window after the grace period, paying 0.5 a leg", async () => {
      await expect(factory.voidWindow(0)).to.be.revertedWithCustomError(factory, "GraceNotElapsed");

      await time.increaseTo(endTs + 3600 + 1);
      await expect(factory.connect(stranger).voidWindow(0)).to.emit(factory, "WindowVoided");

      const w = await factory.getWindow(0);
      const yes = await ethers.getContractAt("OutcomeToken", w.yes);
      // Give the taker a naked YES position so the 0.5 payout is visible.
      await yes.connect(maker).transfer(taker.address, 200n * USD);

      const before = await usdc.balanceOf(taker.address);
      await factory.connect(taker).redeem(0);
      expect((await usdc.balanceOf(taker.address)) - before).to.equal(100n * USD);
    });
  });

  describe("end to end: seed the book, take the offer, redeem the winner", () => {
    it("moves the same collateral a trader would expect", async () => {
      const w = await openWindow();
      const yes = await ethers.getContractAt("OutcomeToken", w.yes);
      const book = (await ethers.getContractAt("MockKuruOrderBook", w.yesMarket)) as MockKuruOrderBook;

      // We seed both sides of every window. Inventory comes from minting sets --
      // there is no privileged mint, this is the same call a trader makes.
      await factory.connect(maker).mintSet(0, 1_000n * USD);
      await yes.connect(maker).approve(await book.getAddress(), ethers.MaxUint256);
      await usdc.connect(maker).approve(await book.getAddress(), ethers.MaxUint256);
      await usdc.connect(taker).approve(await book.getAddress(), ethers.MaxUint256);

      // Quote 0.40 bid / 0.44 ask, 200 contracts a side.
      await book.connect(maker).addBuyOrder(Number(prob(0.4)), contracts(200), true);
      await expect(book.connect(maker).addSellOrder(Number(prob(0.44)), contracts(200), true)).to.emit(
        book,
        "OrderCreated",
      );

      const [bid, ask] = await book.bestBidAsk();
      expect(bid).to.equal(prob(0.4));
      expect(ask).to.equal(prob(0.44));

      // Taker lifts the offer for 100 contracts: pays 100 * 0.44 = 44 USDC.
      const takerUsdcBefore = await usdc.balanceOf(taker.address);
      await expect(book.connect(taker).addBuyOrder(Number(prob(0.44)), contracts(100), false)).to.emit(book, "Trade");

      expect(takerUsdcBefore - (await usdc.balanceOf(taker.address))).to.equal(44n * USD);
      expect(await yes.balanceOf(taker.address)).to.equal(100n * USD);

      // BTC prints above the strike: YES pays 1.
      await time.increaseTo(endTs + 1);
      await factory.connect(settler).settle(0, strikeE8 + 500n * E8);

      const beforeRedeem = await usdc.balanceOf(taker.address);
      await factory.connect(taker).redeem(0);
      const payout = (await usdc.balanceOf(taker.address)) - beforeRedeem;

      expect(payout).to.equal(100n * USD); // 100 contracts * $1
      expect(payout - 44n * USD).to.equal(56n * USD); // net profit on a 44-dollar risk
    });
  });
});

// Small matchers so the assertions above read like sentences.
const anyAddress = (value: string) => ethers.isAddress(value) && value !== ethers.ZeroAddress;
const anyUint = (value: bigint) => value > 0n;

describe("PitFactory.pendingSettlement", () => {
  // The Chainlink CRE workflow's only read. It has to be exactly right, because a
  // window it fails to report is a window that sits unsettled until someone voids it.
  let owner: HardhatEthersSigner;
  let settler: HardhatEthersSigner;
  let factory: PitFactory;
  let endTs: number;

  beforeEach(async () => {
    [owner, settler] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const router = await (await ethers.getContractFactory("MockKuruRouter")).deploy();
    factory = await (
      await ethers.getContractFactory("PitFactory")
    ).deploy(owner.address, await usdc.getAddress(), await router.getAddress(), settler.address, owner.address);

    const startTs = (await time.latest()) + 10;
    endTs = startTs + 300;
    // One column of three strikes closing at endTs, plus one that closes later.
    for (const strike of [64_000n * E8, 65_000n * E8, 66_000n * E8]) {
      await factory.createWindow(BTC_USD, startTs, endTs, strike);
    }
    await factory.createWindow(BTC_USD, startTs, endTs + 300, 65_000n * E8);
  });

  it("returns nothing while every window is still open", async () => {
    expect(await factory.pendingSettlement(50, 10)).to.deep.equal([]);
  });

  it("returns only closed, unresolved windows", async () => {
    await time.increaseTo(endTs + 1);
    const pending = await factory.pendingSettlement(50, 10);
    expect([...pending].map(Number).sort()).to.deep.equal([0, 1, 2]); // not #3, it closes later

    await factory.connect(settler).settle(1, 65_500n * E8);
    const after = await factory.pendingSettlement(50, 10);
    expect([...after].map(Number).sort()).to.deep.equal([0, 2]);
  });

  it("respects maxResults, so one report never grows unbounded", async () => {
    await time.increaseTo(endTs + 1);
    expect((await factory.pendingSettlement(50, 2)).length).to.equal(2);
  });

  it("respects lookback, scanning backwards from the newest window", async () => {
    await time.increaseTo(endTs + 1);
    // Only the last two windows are scanned: #3 (still open) and #2 (closed).
    expect([...(await factory.pendingSettlement(2, 10))].map(Number)).to.deep.equal([2]);
  });
});
