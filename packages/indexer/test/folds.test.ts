/**
 * Replays a window's worth of Kuru logs and checks the book that falls out.
 *
 * The sequence below is exactly what happens on a real cell: a maker quotes both
 * sides, a taker lifts part of the offer, a second maker joins the bid, the
 * first maker pulls. Every assertion is something the UI actually renders, so a
 * failure here is a wrong number on the grid, not an abstract invariant.
 *
 *   node --experimental-strip-types --test src/folds.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryStore } from "../src/memory-store.ts";
import {
  applyOrderCreated,
  applyOrdersCanceled,
  applyTrade,
  type BookLevelRow,
  type CellStateRow,
  type Store,
} from "../src/folds.ts";

const MARKET = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const MAKER_A = "0x1111111111111111111111111111111111111111";
const MAKER_B = "0x2222222222222222222222222222222222222222";
const TAKER = "0x3333333333333333333333333333333333333333";

/** 100 contracts, in Kuru size units. */
const size = (contracts: number) => BigInt(contracts) * 1_000_000n;
/** 0.42 as a Kuru tick. */
const tick = (probability: number) => BigInt(Math.round(probability * 1_000_000));

const makeStore = createMemoryStore;

function seedCell(store: Store) {
  store.CellState.set({
    id: MARKET.toLowerCase(),
    market_id: MARKET.toLowerCase(),
    window_id: "7",
    windowId: 7n,
    side: "YES",
    underlying: "0xbtc",
    endTs: 1_800n,
    strikeE8: 6_500_000_000_000n,
    bestBid: undefined,
    bestAsk: undefined,
    lastPrice: undefined,
    bidDepth: 0n,
    askDepth: 0n,
    makers: 0,
    volume: 0n,
    tradeCount: 0,
    cvd: 0n,
    outcome: 0,
    updatedAtBlock: 0n,
    updatedAtTs: 0n,
  });
  store.Window.set({
    id: "7",
    volume: 0n,
    tradeCount: 0,
    yesMarket: MARKET.toLowerCase(),
    noMarket: "0xbb",
    outcome: 0,
    settlePriceE8: 0n,
    settledAt: 0n,
    collateral: 0n,
  });
}

const block = (n: number, ts: number) => ({ number: n, timestamp: ts });

test("a quoted two-sided market shows the right best bid, best ask and depth", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 1n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.4),
    isBuy: true,
    txHash: "0xa1",
    block: block(10, 1_000),
  });
  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.44),
    isBuy: false,
    txHash: "0xa2",
    block: block(10, 1_000),
  });

  const cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.bestBid, tick(0.4));
  assert.equal(cell.bestAsk, tick(0.44));
  assert.equal(cell.bidDepth, size(200));
  assert.equal(cell.askDepth, size(200));
  assert.equal(cell.makers, 1, "one address quoting both sides is one maker, not two");
});

test("a taker lifting the offer moves depth, tape and CVD together", async () => {
  const { store, row, rows } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.44),
    isBuy: false,
    txHash: "0xa2",
    block: block(10, 1_000),
  });

  // The taker buys 100 at 0.44. Kuru reports the maker's remaining size (100).
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false, // the resting order was an offer
    price: tick(0.44),
    updatedSize: size(100),
    takerAddress: TAKER,
    filledSize: size(100),
    txHash: "0xb1",
    logIndex: 0,
    block: block(11, 1_004),
  });

  const cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.askDepth, size(100), "half the offer is gone");
  assert.equal(cell.bestAsk, tick(0.44), "the rest of the level is still there");
  assert.equal(cell.lastPrice, tick(0.44));
  assert.equal(cell.volume, size(100));
  assert.equal(cell.tradeCount, 1);
  assert.equal(cell.cvd, size(100), "lifting the offer is positive aggression");

  const level = rows<BookLevelRow>("BookLevel").find((l) => !l.isBuy)!;
  assert.equal(level.size, size(100));
  assert.equal(level.orderCount, 1, "a partial fill does not remove the order");

  assert.equal(rows("Fill").length, 1);
  const [bucket] = rows<{ cvd: bigint; delta: bigint; trades: number }>("WindowCvd");
  assert.equal(bucket!.cvd, size(100));
  assert.equal(bucket!.trades, 1);
});

test("a taker hitting the bid pushes CVD the other way", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 1n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.4),
    isBuy: true,
    txHash: "0xa1",
    block: block(10, 1_000),
  });

  await applyTrade(store, {
    market: MARKET,
    orderId: 1n,
    makerAddress: MAKER_A,
    isBuy: true, // the resting order was a bid
    price: tick(0.4),
    updatedSize: size(150),
    takerAddress: TAKER,
    filledSize: size(50),
    txHash: "0xb2",
    logIndex: 0,
    block: block(11, 1_004),
  });

  const cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.cvd, -size(50));
  assert.equal(cell.bidDepth, size(150));
});

test("a fully filled order leaves the book and stops counting as a maker", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(100),
    price: tick(0.44),
    isBuy: false,
    txHash: "0xa2",
    block: block(10, 1_000),
  });
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false,
    price: tick(0.44),
    updatedSize: 0n,
    takerAddress: TAKER,
    filledSize: size(100),
    txHash: "0xb3",
    logIndex: 0,
    block: block(11, 1_004),
  });

  const cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.bestAsk, undefined, "an empty level must not remain the best ask");
  assert.equal(cell.askDepth, 0n);
  assert.equal(cell.makers, 0);
});

test("cancels remove exactly the remaining size, and are idempotent", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 1n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.4),
    isBuy: true,
    txHash: "0xa1",
    block: block(10, 1_000),
  });
  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 3n,
    owner: MAKER_B,
    size: size(50),
    price: tick(0.41),
    isBuy: true,
    txHash: "0xa3",
    block: block(10, 1_000),
  });

  assert.equal(row<CellStateRow>("CellState", MARKET.toLowerCase())!.bestBid, tick(0.41));
  assert.equal(row<CellStateRow>("CellState", MARKET.toLowerCase())!.makers, 2);

  // Maker B pulls: the best bid falls back to maker A's price.
  await applyOrdersCanceled(store, {
    market: MARKET,
    orderIds: [3n],
    owner: MAKER_B,
    block: block(12, 1_010),
  });

  let cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.bestBid, tick(0.4));
  assert.equal(cell.bidDepth, size(200));
  assert.equal(cell.makers, 1);

  // Kuru's cancel is idempotent; replaying it must not double-subtract.
  await applyOrdersCanceled(store, {
    market: MARKET,
    orderIds: [3n, 999n],
    owner: MAKER_B,
    block: block(13, 1_012),
  });

  cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.bidDepth, size(200), "a replayed cancel must not remove size twice");
  assert.equal(cell.makers, 1);
});

test("a partially filled order that is then cancelled removes only what was left", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(200),
    price: tick(0.44),
    isBuy: false,
    txHash: "0xa2",
    block: block(10, 1_000),
  });
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false,
    price: tick(0.44),
    updatedSize: size(120),
    takerAddress: TAKER,
    filledSize: size(80),
    txHash: "0xb4",
    logIndex: 0,
    block: block(11, 1_004),
  });
  await applyOrdersCanceled(store, {
    market: MARKET,
    orderIds: [2n],
    owner: MAKER_A,
    block: block(12, 1_008),
  });

  const cell = row<CellStateRow>("CellState", MARKET.toLowerCase())!;
  assert.equal(cell.askDepth, 0n);
  assert.equal(cell.bestAsk, undefined);
  assert.equal(cell.volume, size(80), "the fill still counts after the rest is pulled");
});

test("running CVD carries across buckets", async () => {
  const { store, rows } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(500),
    price: tick(0.5),
    isBuy: false,
    txHash: "0xa5",
    block: block(10, 1_000),
  });

  // Two fills, 20 seconds apart, so they land in different 15-second buckets.
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false,
    price: tick(0.5),
    updatedSize: size(400),
    takerAddress: TAKER,
    filledSize: size(100),
    txHash: "0xc1",
    logIndex: 0,
    block: block(11, 1_000),
  });
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false,
    price: tick(0.5),
    updatedSize: size(340),
    takerAddress: TAKER,
    filledSize: size(60),
    txHash: "0xc2",
    logIndex: 0,
    block: block(12, 1_020),
  });

  const buckets = rows<{ bucketTs: bigint; cvd: bigint; delta: bigint }>("WindowCvd").sort((a, b) =>
    a.bucketTs < b.bucketTs ? -1 : 1,
  );
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]!.cvd, size(100));
  assert.equal(buckets[1]!.cvd, size(160), "the second bucket carries the running total");
  assert.equal(buckets[1]!.delta, size(60), "delta is this bucket alone");
});

test("window volume aggregates across both legs of the same window", async () => {
  const { store, row } = makeStore();
  seedCell(store);

  await applyOrderCreated(store, {
    market: MARKET,
    orderId: 2n,
    owner: MAKER_A,
    size: size(300),
    price: tick(0.5),
    isBuy: false,
    txHash: "0xa6",
    block: block(10, 1_000),
  });
  await applyTrade(store, {
    market: MARKET,
    orderId: 2n,
    makerAddress: MAKER_A,
    isBuy: false,
    price: tick(0.5),
    updatedSize: size(200),
    takerAddress: TAKER,
    filledSize: size(100),
    txHash: "0xd1",
    logIndex: 0,
    block: block(11, 1_004),
  });

  const window = row<{ volume: bigint; tradeCount: number }>("Window", "7")!;
  assert.equal(window.volume, size(100));
  assert.equal(window.tradeCount, 1);
});
