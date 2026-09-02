/**
 * Kuru OrderBook: the three events that are the cell's book.
 *
 * Kuru gives us exactly what a book needs and nothing more:
 *
 *   OrderCreated    a resting order appeared (size here is the resting remainder,
 *                   so a marketable order that fully filled never shows up)
 *   Trade           one fill, with the maker's remaining size already computed
 *   OrdersCanceled  a batch of ids left the book
 *
 * From those we fold BookLevel (depth per price), MarketMaker (who is quoting),
 * CellState (the row the grid paints) and WindowCvd (signed taker flow). The UI
 * reads those four and never touches an RPC.
 */
import { indexer } from "envio";

import { bucketOf, cvdKey, fillKey, levelKey, lower, makerKey, marketId, orderKey } from "../shared";

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCreated" }, async ({ event, context }) => {
  const market = marketId(event.srcAddress);
  const { orderId, owner, size, price, isBuy } = event.params;

  context.Order.set({
    id: orderKey(market, orderId),
    market_id: market,
    orderId,
    owner: lower(owner),
    isBuy,
    price: BigInt(price),
    size,
    remainingSize: size,
    status: "open",
    createdAtBlock: BigInt(event.block.number),
    createdAtTs: BigInt(event.block.timestamp),
    updatedAtBlock: BigInt(event.block.number),
    txHash: event.transaction.hash,
  });

  await addDepth(context, market, isBuy, BigInt(price), size, 1, event.block.number);
  await addMakerOrder(context, market, owner, size, 1);
  await touchAccount(context, owner, event.block.timestamp, { ordersPlaced: 1 });
  await refreshCell(context, market, event.block);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "OrdersCanceled" }, async ({ event, context }) => {
  const market = marketId(event.srcAddress);

  for (const orderId of event.params.orderId) {
    const order = await context.Order.get(orderKey(market, orderId));
    // Kuru's cancel is idempotent and can name an order we never saw rest.
    if (!order || order.status !== "open") continue;

    context.Order.set({
      ...order,
      status: "canceled",
      remainingSize: 0n,
      updatedAtBlock: BigInt(event.block.number),
    });

    await addDepth(context, market, order.isBuy, order.price, -order.remainingSize, -1, event.block.number);
    await addMakerOrder(context, market, order.owner, -order.remainingSize, -1);
  }

  await touchAccount(context, event.params.owner, event.block.timestamp, {
    ordersCanceled: event.params.orderId.length,
  });
  await refreshCell(context, market, event.block);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade" }, async ({ event, context }) => {
  const market = marketId(event.srcAddress);
  const { orderId, makerAddress, isBuy, price, updatedSize, takerAddress, filledSize } = event.params;

  const cell = await context.CellState.get(market);
  const order = await context.Order.get(orderKey(market, orderId));

  // The maker was bidding, so the taker sold into the bid: aggression is negative.
  // The maker was offering, so the taker lifted it: aggression is positive.
  const signedSize = isBuy ? -filledSize : filledSize;

  context.Fill.set({
    id: fillKey(event.transaction.hash, event.logIndex),
    market_id: market,
    windowId: cell?.windowId ?? 0n,
    orderId,
    maker: lower(makerAddress),
    taker: lower(takerAddress),
    makerIsBuy: isBuy,
    price,
    filledSize,
    notional: price * filledSize,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });

  if (order) {
    // Kuru reports the maker's remaining size, so we trust it instead of
    // subtracting and hoping we never dropped a log.
    const consumed = order.remainingSize - updatedSize;
    context.Order.set({
      ...order,
      remainingSize: updatedSize,
      status: updatedSize === 0n ? "filled" : "open",
      updatedAtBlock: BigInt(event.block.number),
    });
    await addDepth(context, market, isBuy, price, -consumed, updatedSize === 0n ? -1 : 0, event.block.number);
    await addMakerOrder(context, market, makerAddress, -consumed, updatedSize === 0n ? -1 : 0);
  } else {
    await addDepth(context, market, isBuy, price, -filledSize, 0, event.block.number);
  }

  await bumpCvd(context, market, cell?.windowId ?? 0n, BigInt(event.block.timestamp), signedSize, filledSize);
  await touchAccount(context, makerAddress, event.block.timestamp, { fillsAsMaker: 1, volume: filledSize });
  await touchAccount(context, takerAddress, event.block.timestamp, { fillsAsTaker: 1, volume: filledSize });

  await refreshCell(context, market, event.block, { lastPrice: price, filledSize, signedSize });
});

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

/** Move depth at one price. `sizeDelta` and `countDelta` may be negative. */
async function addDepth(
  context: any,
  market: string,
  isBuy: boolean,
  price: bigint,
  sizeDelta: bigint,
  countDelta: number,
  blockNumber: number,
) {
  const id = levelKey(market, isBuy, price);
  const level = await context.BookLevel.get(id);

  const size = (level?.size ?? 0n) + sizeDelta;
  const orderCount = (level?.orderCount ?? 0) + countDelta;

  context.BookLevel.set({
    id,
    market_id: market,
    isBuy,
    price,
    // Clamp rather than trust arithmetic across a reorg boundary: a negative
    // level would silently poison every best-bid read that follows.
    size: size > 0n ? size : 0n,
    orderCount: orderCount > 0 ? orderCount : 0,
    updatedAtBlock: BigInt(blockNumber),
  });
}

async function addMakerOrder(context: any, market: string, owner: string, sizeDelta: bigint, countDelta: number) {
  const id = makerKey(market, owner);
  const maker = await context.MarketMaker.get(id);

  const liveOrders = (maker?.liveOrders ?? 0) + countDelta;
  const restingSize = (maker?.restingSize ?? 0n) + sizeDelta;

  context.MarketMaker.set({
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
 * Depth per market is small — a handful of price levels over a five-minute life —
 * so scanning them is cheaper and far less error-prone than maintaining an
 * incremental best-bid that has to be right across cancels, fills and reorgs.
 */
async function refreshCell(
  context: any,
  market: string,
  block: { number: number; timestamp: number },
  trade?: { lastPrice: bigint; filledSize: bigint; signedSize: bigint },
) {
  const cell = await context.CellState.get(market);
  if (!cell) return;

  const levels = await context.BookLevel.getWhere({ market_id: { _eq: market } });
  const makers = await context.MarketMaker.getWhere({ market_id: { _eq: market } });

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

  context.CellState.set({
    ...cell,
    bestBid,
    bestAsk,
    bidDepth,
    askDepth,
    makers: makers.filter((m: { liveOrders: number }) => m.liveOrders > 0).length,
    lastPrice: trade ? trade.lastPrice : cell.lastPrice,
    volume: trade ? cell.volume + trade.filledSize : cell.volume,
    tradeCount: trade ? cell.tradeCount + 1 : cell.tradeCount,
    cvd: trade ? cell.cvd + trade.signedSize : cell.cvd,
    updatedAtBlock: BigInt(block.number),
    updatedAtTs: BigInt(block.timestamp),
  });

  if (trade) {
    const window = await context.Window.get(cell.window_id);
    if (window) {
      context.Window.set({
        ...window,
        volume: window.volume + trade.filledSize,
        tradeCount: window.tradeCount + 1,
      });
    }
  }
}

/** 15-second buckets of signed taker flow, carrying the running total forward. */
async function bumpCvd(
  context: any,
  market: string,
  windowId: bigint,
  timestamp: bigint,
  signedSize: bigint,
  filledSize: bigint,
) {
  const bucketTs = bucketOf(timestamp);
  const id = cvdKey(market, bucketTs);
  const existing = await context.WindowCvd.get(id);

  // The running total lives on CellState, which is the only place that has seen
  // every fill in order.
  const cell = await context.CellState.get(market);
  const runningCvd = (cell?.cvd ?? 0n) + signedSize;

  context.WindowCvd.set({
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

async function touchAccount(
  context: any,
  address: string,
  timestamp: number,
  delta: { ordersPlaced?: number; ordersCanceled?: number; fillsAsMaker?: number; fillsAsTaker?: number; volume?: bigint },
) {
  const id = lower(address);
  const existing = await context.Account.get(id);
  const ts = BigInt(timestamp);

  context.Account.set({
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
