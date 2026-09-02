/**
 * Kuru OrderBook: the three events that are the cell's book.
 *
 *   OrderCreated    a resting order appeared (the size is the resting remainder,
 *                   so a marketable order that fully filled never shows up here)
 *   Trade           one fill, with the maker's remaining size already computed
 *   OrdersCanceled  a batch of ids left the book
 *
 * These handlers are thin on purpose. Everything they do lives in ../folds.ts,
 * which is plain functions over a small store interface, so the arithmetic that
 * produces a best bid and a running CVD is covered by folds.test.ts rather than
 * only by running the whole indexer.
 */
import { indexer } from "envio";

import { applyOrderCreated, applyOrdersCanceled, applyTrade, type Store } from "../folds.ts";

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCreated" }, async ({ event, context }) => {
  await applyOrderCreated(context as unknown as Store, {
    market: event.srcAddress,
    orderId: event.params.orderId,
    owner: event.params.owner,
    size: event.params.size,
    price: BigInt(event.params.price),
    isBuy: event.params.isBuy,
    txHash: event.transaction.hash,
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});

indexer.onEvent({ contract: "KuruOrderBook", event: "OrdersCanceled" }, async ({ event, context }) => {
  await applyOrdersCanceled(context as unknown as Store, {
    market: event.srcAddress,
    orderIds: [...event.params.orderId],
    owner: event.params.owner,
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade" }, async ({ event, context }) => {
  await applyTrade(context as unknown as Store, {
    market: event.srcAddress,
    orderId: event.params.orderId,
    makerAddress: event.params.makerAddress,
    isBuy: event.params.isBuy,
    price: event.params.price,
    updatedSize: event.params.updatedSize,
    takerAddress: event.params.takerAddress,
    filledSize: event.params.filledSize,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});
