/**
 * CellFactory: issuance, settlement, and the dynamic registration that makes the
 * rest of the indexer work.
 *
 * A window's two Kuru markets do not exist when the indexer starts. The
 * contractRegister hook on WindowCreated adds both addresses the instant they
 * are announced, so orderbook.ts starts receiving their logs from the very same
 * block — no restart, no address list to maintain.
 */
import { indexer } from "envio";

import { marketId, windowIdOf, OUTCOME } from "../shared";

indexer.contractRegister({ contract: "CellFactory", event: "WindowCreated" }, ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.yesMarket);
  context.chain.KuruOrderBook.add(event.params.noMarket);
  context.log.info(
    `window ${event.params.windowId}: following ${event.params.yesMarket} (YES) and ${event.params.noMarket} (NO)`,
  );
});

indexer.onEvent({ contract: "CellFactory", event: "WindowCreated" }, async ({ event, context }) => {
  const id = windowIdOf(event.params.windowId);

  context.Window.set({
    id,
    windowId: event.params.windowId,
    underlying: event.params.underlying,
    startTs: BigInt(event.params.startTs),
    endTs: BigInt(event.params.endTs),
    strikeE8: event.params.strikeE8,
    yesToken: event.params.yes,
    noToken: event.params.no,
    yesMarket: event.params.yesMarket,
    noMarket: event.params.noMarket,
    collateral: 0n,
    outcome: OUTCOME.Unresolved,
    settlePriceE8: 0n,
    settledAt: 0n,
    createdAtBlock: BigInt(event.block.number),
    createdAtTs: BigInt(event.block.timestamp),
    volume: 0n,
    tradeCount: 0,
  });

  for (const [side, market, token] of [
    ["YES", event.params.yesMarket, event.params.yes],
    ["NO", event.params.noMarket, event.params.no],
  ] as const) {
    context.Market.set({
      id: marketId(market),
      window_id: id,
      windowId: event.params.windowId,
      side,
      baseToken: token,
      quoteToken: "",
      endTs: BigInt(event.params.endTs),
      strikeE8: event.params.strikeE8,
      createdAtBlock: BigInt(event.block.number),
    });

    // A cell exists on the grid before anyone quotes it. Writing CellState here
    // means an empty cell renders as "no book yet" rather than as a hole.
    context.CellState.set({
      id: marketId(market),
      market_id: marketId(market),
      window_id: id,
      windowId: event.params.windowId,
      side,
      underlying: event.params.underlying,
      endTs: BigInt(event.params.endTs),
      strikeE8: event.params.strikeE8,
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
});

indexer.onEvent({ contract: "CellFactory", event: "SetMinted" }, async ({ event, context }) => {
  await adjustCollateral(context, event.params.windowId, event.params.amount);
});

indexer.onEvent({ contract: "CellFactory", event: "SetBurned" }, async ({ event, context }) => {
  await adjustCollateral(context, event.params.windowId, -event.params.amount);
});

indexer.onEvent({ contract: "CellFactory", event: "Redeemed" }, async ({ event, context }) => {
  await adjustCollateral(context, event.params.windowId, -event.params.payout);
});

indexer.onEvent({ contract: "CellFactory", event: "WindowSettled" }, async ({ event, context }) => {
  await resolve(context, event.params.windowId, Number(event.params.outcome), {
    settlePriceE8: event.params.settlePriceE8,
    settledAt: BigInt(event.params.settledAt),
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "CellFactory", event: "WindowVoided" }, async ({ event, context }) => {
  await resolve(context, event.params.windowId, OUTCOME.Void, {
    settlePriceE8: 0n,
    settledAt: BigInt(event.params.voidedAt),
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
  });
});

/** Open interest, tracked from the events rather than re-read from the chain. */
async function adjustCollateral(context: any, windowId: bigint, delta: bigint) {
  const id = windowIdOf(windowId);
  const window = await context.Window.get(id);
  if (!window) return;
  context.Window.set({ ...window, collateral: window.collateral + delta });
}

/** Mirror the outcome onto both legs so the grid greys a settled cell in one read. */
async function resolve(
  context: any,
  windowId: bigint,
  outcome: number,
  meta: { settlePriceE8: bigint; settledAt: bigint; blockNumber: bigint; timestamp: bigint },
) {
  const id = windowIdOf(windowId);
  const window = await context.Window.get(id);
  if (!window) return;

  context.Window.set({
    ...window,
    outcome,
    settlePriceE8: meta.settlePriceE8,
    settledAt: meta.settledAt,
  });

  for (const market of [window.yesMarket, window.noMarket]) {
    const cell = await context.CellState.get(marketId(market));
    if (!cell) continue;
    context.CellState.set({
      ...cell,
      outcome,
      updatedAtBlock: meta.blockNumber,
      updatedAtTs: meta.timestamp,
    });
  }
}
