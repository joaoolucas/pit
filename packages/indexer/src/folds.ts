/**
 * The folds, separated from the handlers that register them.
 *
 * Everything interesting about this indexer is here: how a Kuru log becomes a
 * price level, a maker count, a running CVD and the single row the grid paints.
 * Keeping it out of `indexer.onEvent` callbacks means it can be exercised
 * directly — see folds.test.ts, which replays a whole window's worth of events
 * against an in-memory store and checks the book that comes out.
 *
 * The `Store` interface is the subset of Envio's handler context these functions
 * touch, so the real context satisfies it structurally with no adapter.
 */

import {
  bucketOf,
  cvdKey,
  fillKey,
  levelKey,
  lower,
  makerKey,
  marketId,
  orderKey,
  OUTCOME,
  underlyingLabel,
  windowIdOf,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type OrderRow = {
  id: string;
  market_id: string;
  orderId: bigint;
  owner: string;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  remainingSize: bigint;
  status: "open" | "filled" | "canceled";
  createdAtBlock: bigint;
  createdAtTs: bigint;
  updatedAtBlock: bigint;
  txHash: string;
};

export type BookLevelRow = {
  id: string;
  market_id: string;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  orderCount: number;
  updatedAtBlock: bigint;
};

export type MarketMakerRow = {
  id: string;
  market_id: string;
  owner: string;
  liveOrders: number;
  restingSize: bigint;
};

export type CellStateRow = {
  id: string;
  market_id: string;
  window_id: string;
  windowId: bigint;
  side: string;
  underlying: string;
  endTs: bigint;
  strikeE8: bigint;
  bestBid: bigint | undefined;
  bestAsk: bigint | undefined;
  lastPrice: bigint | undefined;
  bidDepth: bigint;
  askDepth: bigint;
  makers: number;
  volume: bigint;
  tradeCount: number;
  cvd: bigint;
  outcome: number;
  updatedAtBlock: bigint;
  updatedAtTs: bigint;
};

export type WindowCvdRow = {
  id: string;
  market_id: string;
  windowId: bigint;
  bucketTs: bigint;
  cvd: bigint;
  delta: bigint;
  volume: bigint;
  trades: number;
};

export type FillRow = {
  id: string;
  market_id: string;
  windowId: bigint;
  orderId: bigint;
  maker: string;
  taker: string;
  makerIsBuy: boolean;
  price: bigint;
  filledSize: bigint;
  notional: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: string;
};

export type AccountRow = {
  id: string;
  ordersPlaced: number;
  ordersCanceled: number;
  fillsAsMaker: number;
  fillsAsTaker: number;
  volume: bigint;
  firstSeenTs: bigint;
  lastSeenTs: bigint;
};

export type WindowRow = {
  id: string;
  volume: bigint;
  tradeCount: number;
  yesMarket: string;
  noMarket: string;
  outcome: number;
  settlePriceE8: bigint;
  settledAt: bigint;
  collateral: bigint;
};

type Entity<T> = {
  get: (id: string) => Promise<T | undefined>;
  getWhere: (filter: Record<string, { _eq?: unknown }>) => Promise<T[]>;
  set: (entity: T) => void;
};

export type Store = {
  Market?: Entity<Record<string, unknown>>;
  Order: Entity<OrderRow>;
  BookLevel: Entity<BookLevelRow>;
  MarketMaker: Entity<MarketMakerRow>;
  CellState: Entity<CellStateRow>;
  WindowCvd: Entity<WindowCvdRow>;
  Fill: Entity<FillRow>;
  Account: Entity<AccountRow>;
  Window: Entity<WindowRow>;
};

export type BlockInfo = { number: number; timestamp: number };

// ---------------------------------------------------------------------------
// Events, in the shape Kuru emits them
// ---------------------------------------------------------------------------

export type OrderCreatedEvent = {
  market: string;
  orderId: bigint;
  owner: string;
  size: bigint;
  price: bigint;
  isBuy: boolean;
  txHash: string;
  block: BlockInfo;
};

export type OrdersCanceledEvent = {
  market: string;
  orderIds: bigint[];
  owner: string;
  block: BlockInfo;
};

export type TradeEvent = {
  market: string;
  orderId: bigint;
  makerAddress: string;
  /** The maker's side: true when the resting order was a bid. */
  isBuy: boolean;
  price: bigint;
  /** The maker's remaining size after this fill, as Kuru reports it. */
  updatedSize: bigint;
  takerAddress: string;
  filledSize: bigint;
  txHash: string;
  logIndex: number;
  block: BlockInfo;
};

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

export async function applyOrderCreated(store: Store, event: OrderCreatedEvent): Promise<void> {
  const market = marketId(event.market);

  store.Order.set({
    id: orderKey(market, event.orderId),
    market_id: market,
    orderId: event.orderId,
    owner: lower(event.owner),
    isBuy: event.isBuy,
    price: event.price,
    size: event.size,
    remainingSize: event.size,
    status: "open",
    createdAtBlock: BigInt(event.block.number),
    createdAtTs: BigInt(event.block.timestamp),
    updatedAtBlock: BigInt(event.block.number),
    txHash: event.txHash,
  });

  await addDepth(store, market, event.isBuy, event.price, event.size, 1, event.block.number);
  await addMakerOrder(store, market, event.owner, event.size, 1);
  await touchAccount(store, event.owner, event.block.timestamp, { ordersPlaced: 1 });
  await refreshCell(store, market, event.block);
}

export async function applyOrdersCanceled(store: Store, event: OrdersCanceledEvent): Promise<void> {
  const market = marketId(event.market);

  for (const orderId of event.orderIds) {
    const order = await store.Order.get(orderKey(market, orderId));
    // Kuru's cancel is idempotent and can name an order we never saw rest.
    if (!order || order.status !== "open") continue;

    store.Order.set({
      ...order,
      status: "canceled",
      remainingSize: 0n,
      updatedAtBlock: BigInt(event.block.number),
    });

    await addDepth(store, market, order.isBuy, order.price, -order.remainingSize, -1, event.block.number);
    await addMakerOrder(store, market, order.owner, -order.remainingSize, -1);
  }

  await touchAccount(store, event.owner, event.block.timestamp, { ordersCanceled: event.orderIds.length });
  await refreshCell(store, market, event.block);
}

export async function applyTrade(store: Store, event: TradeEvent): Promise<void> {
  const market = marketId(event.market);
  const cell = await store.CellState.get(market);
  const order = await store.Order.get(orderKey(market, event.orderId));

  // The maker was bidding, so the taker sold into the bid: aggression negative.
  // The maker was offering, so the taker lifted it: aggression positive.
  const signedSize = event.isBuy ? -event.filledSize : event.filledSize;

  store.Fill.set({
    id: fillKey(event.txHash, event.logIndex),
    market_id: market,
    windowId: cell?.windowId ?? 0n,
    orderId: event.orderId,
    maker: lower(event.makerAddress),
    taker: lower(event.takerAddress),
    makerIsBuy: event.isBuy,
    price: event.price,
    filledSize: event.filledSize,
    notional: event.price * event.filledSize,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.txHash,
  });

  if (order) {
    // Kuru reports the maker's remaining size, so trust it rather than
    // subtracting and hoping we never dropped a log.
    const consumed = order.remainingSize - event.updatedSize;
    const emptied = event.updatedSize === 0n;

    store.Order.set({
      ...order,
      remainingSize: event.updatedSize,
      status: emptied ? "filled" : "open",
      updatedAtBlock: BigInt(event.block.number),
    });

    await addDepth(store, market, event.isBuy, event.price, -consumed, emptied ? -1 : 0, event.block.number);
    await addMakerOrder(store, market, event.makerAddress, -consumed, emptied ? -1 : 0);
  } else {
    await addDepth(store, market, event.isBuy, event.price, -event.filledSize, 0, event.block.number);
  }

  await bumpCvd(store, market, cell?.windowId ?? 0n, BigInt(event.block.timestamp), signedSize, event.filledSize);
  await touchAccount(store, event.makerAddress, event.block.timestamp, {
    fillsAsMaker: 1,
    volume: event.filledSize,
  });
  await touchAccount(store, event.takerAddress, event.block.timestamp, {
    fillsAsTaker: 1,
    volume: event.filledSize,
  });

  await refreshCell(store, market, event.block, {
    lastPrice: event.price,
    filledSize: event.filledSize,
    signedSize,
  });
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Move depth at one price. Both deltas may be negative. */
export async function addDepth(
  store: Store,
  market: string,
  isBuy: boolean,
  price: bigint,
  sizeDelta: bigint,
  countDelta: number,
  blockNumber: number,
): Promise<void> {
  const id = levelKey(market, isBuy, price);
  const level = await store.BookLevel.get(id);

  const size = (level?.size ?? 0n) + sizeDelta;
  const orderCount = (level?.orderCount ?? 0) + countDelta;

  store.BookLevel.set({
    id,
    market_id: market,
    isBuy,
    price,
    // Clamp rather than trust arithmetic across a reorg boundary: one negative
    // level would silently poison every best-bid read that follows.
    size: size > 0n ? size : 0n,
    orderCount: orderCount > 0 ? orderCount : 0,
    updatedAtBlock: BigInt(blockNumber),
  });
}

export async function addMakerOrder(
  store: Store,
  market: string,
  owner: string,
  sizeDelta: bigint,
  countDelta: number,
): Promise<void> {
  const id = makerKey(market, owner);
  const maker = await store.MarketMaker.get(id);

  const liveOrders = (maker?.liveOrders ?? 0) + countDelta;
  const restingSize = (maker?.restingSize ?? 0n) + sizeDelta;

  store.MarketMaker.set({
    id,
    market_id: market,
    owner: lower(owner),
    liveOrders: liveOrders > 0 ? liveOrders : 0,
    restingSize: restingSize > 0n ? restingSize : 0n,
  });
}

/**
 * Recompute the row the grid paints.
 *
 * Depth per market is small — a handful of price levels over a five-minute life
 * — so scanning them is cheaper and far less error-prone than maintaining an
 * incremental best bid that has to stay right across cancels, fills and reorgs.
 */
export async function refreshCell(
  store: Store,
  market: string,
  block: BlockInfo,
  trade?: { lastPrice: bigint; filledSize: bigint; signedSize: bigint },
): Promise<void> {
  const cell = await store.CellState.get(market);
  if (!cell) return;

  const levels = await store.BookLevel.getWhere({ market_id: { _eq: market } });
  const makers = await store.MarketMaker.getWhere({ market_id: { _eq: market } });

  let bestBid: bigint | undefined;
  let bestAsk: bigint | undefined;
  let bidDepth = 0n;
  let askDepth = 0n;

  for (const level of levels) {
    if (level.size <= 0n) continue;
    if (level.isBuy) {
      bidDepth += level.size;
      if (bestBid === undefined || level.price > bestBid) bestBid = level.price;
    } else {
      askDepth += level.size;
      if (bestAsk === undefined || level.price < bestAsk) bestAsk = level.price;
    }
  }

  store.CellState.set({
    ...cell,
    bestBid,
    bestAsk,
    bidDepth,
    askDepth,
    makers: makers.filter((maker) => maker.liveOrders > 0).length,
    lastPrice: trade ? trade.lastPrice : cell.lastPrice,
    volume: trade ? cell.volume + trade.filledSize : cell.volume,
    tradeCount: trade ? cell.tradeCount + 1 : cell.tradeCount,
    cvd: trade ? cell.cvd + trade.signedSize : cell.cvd,
    updatedAtBlock: BigInt(block.number),
    updatedAtTs: BigInt(block.timestamp),
  });

  if (trade) {
    const window = await store.Window.get(cell.window_id);
    if (window) {
      store.Window.set({
        ...window,
        volume: window.volume + trade.filledSize,
        tradeCount: window.tradeCount + 1,
      });
    }
  }
}

/** 15-second buckets of signed taker flow, carrying the running total forward. */
export async function bumpCvd(
  store: Store,
  market: string,
  windowId: bigint,
  timestamp: bigint,
  signedSize: bigint,
  filledSize: bigint,
): Promise<void> {
  const bucketTs = bucketOf(timestamp);
  const id = cvdKey(market, bucketTs);
  const existing = await store.WindowCvd.get(id);

  // The running total lives on CellState, the only place that has seen every
  // fill in order.
  const cell = await store.CellState.get(market);
  const runningCvd = (cell?.cvd ?? 0n) + signedSize;

  store.WindowCvd.set({
    id,
    market_id: market,
    windowId,
    bucketTs,
    cvd: runningCvd,
    delta: (existing?.delta ?? 0n) + signedSize,
    volume: (existing?.volume ?? 0n) + filledSize,
    trades: (existing?.trades ?? 0) + 1,
  });
}

export async function touchAccount(
  store: Store,
  address: string,
  timestamp: number,
  delta: {
    ordersPlaced?: number;
    ordersCanceled?: number;
    fillsAsMaker?: number;
    fillsAsTaker?: number;
    volume?: bigint;
  },
): Promise<void> {
  const id = lower(address);
  const existing = await store.Account.get(id);
  const ts = BigInt(timestamp);

  store.Account.set({
    id,
    ordersPlaced: (existing?.ordersPlaced ?? 0) + (delta.ordersPlaced ?? 0),
    ordersCanceled: (existing?.ordersCanceled ?? 0) + (delta.ordersCanceled ?? 0),
    fillsAsMaker: (existing?.fillsAsMaker ?? 0) + (delta.fillsAsMaker ?? 0),
    fillsAsTaker: (existing?.fillsAsTaker ?? 0) + (delta.fillsAsTaker ?? 0),
    volume: (existing?.volume ?? 0n) + (delta.volume ?? 0n),
    firstSeenTs: existing?.firstSeenTs ?? ts,
    lastSeenTs: ts,
  });
}

// ---------------------------------------------------------------------------
// CellFactory folds
//
// Shared with the local dev harness so a window opens the same way whether the
// logs arrive from HyperSync or from eth_getLogs on a Hardhat node.
// ---------------------------------------------------------------------------

export type WindowCreatedEvent = {
  windowId: bigint;
  underlying: string;
  startTs: bigint;
  endTs: bigint;
  strikeE8: bigint;
  yes: string;
  no: string;
  yesMarket: string;
  noMarket: string;
  block: BlockInfo;
};

export async function applyWindowCreated(store: Store, event: WindowCreatedEvent): Promise<void> {
  const id = windowIdOf(event.windowId);
  const label = underlyingLabel(event.underlying);

  store.Window.set({
    id,
    windowId: event.windowId,
    underlying: label,
    startTs: event.startTs,
    endTs: event.endTs,
    strikeE8: event.strikeE8,
    yesToken: event.yes,
    noToken: event.no,
    yesMarket: marketId(event.yesMarket),
    noMarket: marketId(event.noMarket),
    collateral: 0n,
    outcome: OUTCOME.Unresolved,
    settlePriceE8: 0n,
    settledAt: 0n,
    createdAtBlock: BigInt(event.block.number),
    createdAtTs: BigInt(event.block.timestamp),
    volume: 0n,
    tradeCount: 0,
  } as never);

  for (const [side, market, token] of [
    ["YES", event.yesMarket, event.yes],
    ["NO", event.noMarket, event.no],
  ] as const) {
    store.Market?.set({
      id: marketId(market),
      window_id: id,
      windowId: event.windowId,
      side,
      baseToken: token,
      quoteToken: "",
      endTs: event.endTs,
      strikeE8: event.strikeE8,
      createdAtBlock: BigInt(event.block.number),
    } as never);

    // A cell exists on the grid before anyone quotes it. Writing CellState here
    // means an unquoted cell renders as "no book yet" rather than as a hole.
    store.CellState.set({
      id: marketId(market),
      market_id: marketId(market),
      window_id: id,
      windowId: event.windowId,
      side,
      underlying: label,
      endTs: event.endTs,
      strikeE8: event.strikeE8,
      bestBid: undefined,
      bestAsk: undefined,
      lastPrice: undefined,
      bidDepth: 0n,
      askDepth: 0n,
      makers: 0,
      volume: 0n,
      tradeCount: 0,
      cvd: 0n,
      outcome: OUTCOME.Unresolved,
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTs: BigInt(event.block.timestamp),
    });
  }
}

/** Mirror an outcome onto the window and both of its legs. */
export async function applyWindowResolved(
  store: Store,
  event: {
    windowId: bigint;
    outcome: number;
    settlePriceE8: bigint;
    settledAt: bigint;
    block: BlockInfo;
  },
): Promise<void> {
  const window = await store.Window.get(windowIdOf(event.windowId));
  if (!window) return;

  store.Window.set({
    ...window,
    outcome: event.outcome,
    settlePriceE8: event.settlePriceE8,
    settledAt: event.settledAt,
  });

  for (const market of [window.yesMarket, window.noMarket]) {
    const cell = await store.CellState.get(marketId(market));
    if (!cell) continue;
    store.CellState.set({
      ...cell,
      outcome: event.outcome,
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTs: BigInt(event.block.timestamp),
    });
  }
}

/** Open interest, tracked from mint/burn/redeem rather than re-read from chain. */
export async function applyCollateralDelta(store: Store, windowId: bigint, delta: bigint): Promise<void> {
  const window = await store.Window.get(windowIdOf(windowId));
  if (!window) return;
  store.Window.set({ ...window, collateral: window.collateral + delta });
}
