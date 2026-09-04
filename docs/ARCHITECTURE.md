# Architecture

Five moving parts, and one rule that decides most of the design: **the app never
holds state the chain could hold, and never derives data the indexer could
derive.**

```
                       ┌──────────────────────────────────────────────┐
  PitRollReceiver ────►│  PitFactory                                 │
  (CRE, operator)      │                                              │
                       │  createWindow(underlying, start, end, strike)│
                       │    ├─ new OutcomeToken cYES   (ERC-20, 6dp)  │
                       │    ├─ new OutcomeToken cNO    (ERC-20, 6dp)  │
                       │    └─ Router.deployProxy ×2 ─────────────┐   │
                       │                                          │   │
                       │  mintSet / burnSet     — anyone          │   │
                       │  settle                — settler only    │   │
                       │  voidWindow            — anyone, +1h     │   │
                       │  redeem                — anyone          │   │
                       └──────────────────────────────────────────┼───┘
                                                                  ▼
                                                    ┌────────────────────────┐
  seed.ts ─────── mintSet + batchUpdate ───────────►│  Kuru CLOB             │
  (cron, 1 min)                                     │   cYES/USDC            │
  the app ─────── GTC.placeLimit ──────────────────►│   cNO /USDC            │
                                                    └───────────┬────────────┘
                                                                │
                            OrderCreated · Trade · OrdersCanceled│
                                                                ▼
                                                    ┌────────────────────────┐
                                                    │  Envio HyperIndex      │
                                                    │   contractRegister     │
                                                    │   BookLevel MarketMaker│
                                                    │   CellState WindowCvd  │
                                                    └───────────┬────────────┘
                                                                │ GraphQL
                                                                ▼
                                                    ┌────────────────────────┐
                                                    │  apps/web              │
                                                    └────────────────────────┘

  Chainlink CRE (cron, 30s)
     GET spot                  ──── offchain price, median across the DON
     pendingSettlement()       ──── onchain clock
     report(price, ids[])  ───► Forwarder ──► PitSettlementReceiver ──► settle()
     missingWindows(...)   ───► Forwarder ──► PitRollReceiver       ──► createWindow()
```

## The data path, and what is not in it

The book a cell shows comes from `BookLevel` rows the indexer folded out of
Kuru's logs. There is no fallback that reconstructs a book from `eth_getLogs`
when the indexer is behind, and no local order cache. If the indexer is stale the
header says so, in seconds, because a stale book that looks live is worse than no
book.

The only RPC reads in the app are the ones that must be current at signing time:
token balances and allowances. Orders go out through the Kuru SDK; everything
else comes back through GraphQL.

## Why a strike, and not "up/down"

The contract only knows about strikes. "5m up/down" is the row of the ladder
whose strike is nearest spot — the at-the-money row — which is why adding
above/below rows was a config change rather than a rewrite, and why the same
`settle` path serves both.

`packages/core/src/windows.ts` is the single definition: 5-minute columns, a
strike ladder anchored to a round dollar grid, and the fair-probability reference.
The deploy scripts, the indexer and the web app all import it, so a cell means
one thing everywhere.

## Precision, once

Collateral has 6 decimals. Outcome tokens mirror it, so a set is exactly one
collateral unit with no scaling anywhere. Kuru's `sizePrecision` is 1e6 too, so a
"contract" is a token is a size unit. `pricePrecision` is 1e6 with a tick of
1000, so a tick is 0.001 collateral — 10 bps of probability — and a full 1.0 is
1e6, comfortably inside the `uint32` Kuru stores it in.

`packages/core/src/kuru.ts` holds the conversions and is kept in step with
`PitFactory.marketConfig` by construction: both are constants in the same repo,
and `scripts/export-abi.ts` regenerates the ABIs the app uses from the compiled
artifacts so they cannot drift from what was deployed.

## Trust, and the escape hatch

`settle` is gated on one address and `createWindow` on another. In production
those are `PitSettlementReceiver` and `PitRollReceiver`, which only accept calls
from the Chainlink Forwarder. The deploy script leaves both roles on the deploy
key until a Forwarder address exists, so a demo is never blocked on CRE, and
flipping them is `setSettler` and `setOperator`. On the current testnet
deployment they are still on the deploy key: a Forwarder needs a deployed
workflow, which needs deploy access, which Chainlink declined for this account.
The hedge was written before it was needed and is the reason the board runs.

The safety property that matters is not that the settler is honest — it is that a
dishonest or absent settler cannot trap money. `voidWindow` is callable by
**anyone** an hour after a window closes, and voids pay both legs 0.50. The worst
a stuck oracle can do is cost everyone the spread.

What is *not* protected yet: the receiver trusts the Forwarder and ignores the
report metadata, which also carries the workflow id. Pinning that would stop a
second workflow owned by the same account from settling Pit's windows. It is on
the roadmap and called out in `packages/cre/README.md`.

## Reorgs

`rollback_on_reorg` stays on in the indexer. For a five-minute market a fill
reported twice is worse than one reported a block late.

The folds are written to survive being wrong anyway: `BookLevel` sizes and
`MarketMaker` counts clamp at zero rather than going negative, because a single
negative level would silently poison every best-bid read after it. And
`refreshCell` recomputes the best bid and ask by scanning the market's levels
rather than maintaining an incremental value that has to stay correct across
cancels, fills and rollbacks — depth per market is a handful of price levels over
a five-minute life, so the scan is cheap and the incremental version would be a
bug farm.

## Where each dependency is load-bearing

| Piece            | Remove it and…                                                                 |
| ---------------- | ------------------------------------------------------------------------------ |
| Kuru             | there is no book. Every price in the UI is a level someone posted on Kuru.      |
| Envio            | there is no book *visible*. The grid is a query over derived entities.          |
| Chainlink CRE    | there is no trustworthy settle, and nobody opening the next column. The clock is onchain, the price is not. |
| Mera / PRF       | notes are either plaintext on a server or trapped on one device.                |
| Monad            | a five-minute CLOB of binaries is fiction. 112 books quoted and requoted every minute needs 400ms blocks and cheap gas. |

## Testing

| What                                | Where                                              |
| ----------------------------------- | -------------------------------------------------- |
| issuance, settlement, void, redeem  | `packages/contracts/test/PitFactory.test.ts`      |
| the CRE receiver and batch settle   | `packages/contracts/test/PitSettlementReceiver.test.ts` |
| the CRE roller and missingWindows   | `packages/contracts/test/PitRollReceiver.test.ts`      |
| the fold arithmetic                 | `packages/indexer/test/folds.test.ts`              |
| config vs. the real ABIs            | `packages/indexer/scripts/validate.mjs`            |
| workflow ABI drift + price parsing  | `packages/cre/scripts/check.mjs`                   |

`MockKuruRouter` and `MockKuruOrderBook` are test doubles that emit Kuru's event
signatures byte for byte, verified against `abi/OrderBook.json` in
`@kuru-labs/kuru-sdk`. They exist so the contracts can be exercised on a bare
Hardhat node and so the indexer has a local source of real logs — never so the
app can pretend to have a book.
