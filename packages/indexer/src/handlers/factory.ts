/**
 * PitFactory: issuance, settlement, and the dynamic registration that makes the
 * rest of the indexer work.
 *
 * A window's two Kuru markets do not exist when the indexer starts. The
 * contractRegister hook on WindowCreated adds both addresses the instant they
 * are announced, so orderbook.ts starts receiving their logs from the very same
 * block — no restart, no address list to maintain.
 *
 * As in orderbook.ts, the work itself lives in ../folds.ts so it can be tested
 * and reused by the local dev harness.
 */
import { indexer } from "envio";

import {
  applyCollateralDelta,
  applyWindowCreated,
  applyWindowResolved,
  type Store,
} from "../folds.ts";
import { OUTCOME } from "../shared.ts";

indexer.contractRegister({ contract: "PitFactory", event: "WindowCreated" }, ({ event, context }) => {
  context.chain.KuruOrderBook.add(event.params.yesMarket);
  context.chain.KuruOrderBook.add(event.params.noMarket);
  context.log.info(
    `window ${event.params.windowId}: following ${event.params.yesMarket} (YES) and ${event.params.noMarket} (NO)`,
  );
});

indexer.onEvent({ contract: "PitFactory", event: "WindowCreated" }, async ({ event, context }) => {
  await applyWindowCreated(context as unknown as Store, {
    windowId: event.params.windowId,
    underlying: event.params.underlying,
    startTs: BigInt(event.params.startTs),
    endTs: BigInt(event.params.endTs),
    strikeE8: event.params.strikeE8,
    yes: event.params.yes,
    no: event.params.no,
    yesMarket: event.params.yesMarket,
    noMarket: event.params.noMarket,
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});

indexer.onEvent({ contract: "PitFactory", event: "SetMinted" }, async ({ event, context }) => {
  await applyCollateralDelta(context as unknown as Store, event.params.windowId, event.params.amount);
});

indexer.onEvent({ contract: "PitFactory", event: "SetBurned" }, async ({ event, context }) => {
  await applyCollateralDelta(context as unknown as Store, event.params.windowId, -event.params.amount);
});

indexer.onEvent({ contract: "PitFactory", event: "Redeemed" }, async ({ event, context }) => {
  await applyCollateralDelta(context as unknown as Store, event.params.windowId, -event.params.payout);
});

indexer.onEvent({ contract: "PitFactory", event: "WindowSettled" }, async ({ event, context }) => {
  await applyWindowResolved(context as unknown as Store, {
    windowId: event.params.windowId,
    outcome: Number(event.params.outcome),
    settlePriceE8: event.params.settlePriceE8,
    settledAt: BigInt(event.params.settledAt),
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});

indexer.onEvent({ contract: "PitFactory", event: "WindowVoided" }, async ({ event, context }) => {
  await applyWindowResolved(context as unknown as Store, {
    windowId: event.params.windowId,
    outcome: OUTCOME.Void,
    settlePriceE8: 0n,
    settledAt: BigInt(event.params.voidedAt),
    block: { number: event.block.number, timestamp: event.block.timestamp },
  });
});
