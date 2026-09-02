# Liquidity

A five-minute binary with no resting orders is not a market. This document is the
plan for making sure there always are some, and the numbers behind it.

The plan is executable: it is `packages/contracts/scripts/seed.ts`.

## The shape of the obligation

The board is 8 columns × 7 strikes, and each cell has two legs, so a fully quoted
board is **112 books**. Every one needs a bid and an ask or the cell is a
screenshot.

Two things make that tractable:

**Sets, not positions.** `mintSet(id, n)` locks `n` collateral and returns `n`
cYES *and* `n` cNO. One deposit arms both legs of a cell. And `burnSet` reverses
it before settlement, so capital rolls from window to window rather than being
locked per cell for its whole life.

**Symmetry.** cYES + cNO = 1 collateral, always. Quoting YES at 0.53/0.55 and NO
at 0.45/0.47 is the same position stated twice. A maker who is filled on both
legs at the mid has bought a set for exactly what it is worth and carries no
directional risk — only the spread.

## Sizing

Defaults in `seed.ts`, overridable by environment variable:

| Knob                   | Default | Why                                                              |
| ---------------------- | ------- | ---------------------------------------------------------------- |
| `SIZE`                 | 200     | contracts a side, per leg. 200 contracts is $200 of max payout    |
| `SPREAD_BPS`           | 200     | total market width in probability bps — a 0.02 wide market        |
| `STOP_QUOTING_SECONDS` | 20      | stop quoting this close to the bell                               |

Worst case on one cell: both legs fully lifted at the offer. The maker is short
200 YES and short 200 NO, which is short 200 sets, which is a $200 obligation
against $200 of collateral already locked — plus the spread, collected twice. The
maker cannot be short more than the sets it has minted.

Across a full board at these numbers, the capital committed is on the order of a
few thousand units of collateral. That is a deliberate choice: small enough to
run from a hot key on testnet, large enough that lifting an offer moves real
tokens.

## Pricing

`fairProbabilityAbove` in `packages/core/src/windows.ts`: a driftless lognormal
over the remaining life of the window, with annualised realised vol taken from
the last hour of one-minute Coinbase closes.

It is not a pricing engine and nothing settles on it. It seeds the quote, and the
UI shows the book beside it so a trader can see where the two disagree. When the
vol fetch fails it falls back to 60% annualised, which for BTC is wide enough to
be safe and tight enough to still be a real quote.

The reference price endpoint is the same one the CRE workflow settles on. That is
not a coincidence — if the maker quoted around one source and the window resolved
against another, the maker would be the last to know.

## Two rules that keep it honest

**Nothing is quoted outside `[0.02, 0.98]`.** A market at 0.997 is not liquidity.
It is a free option for anyone with a faster price feed, and a cell that is
permanently 99% is not a market anyone wanted. Those cells show `no book` instead,
which is the truth.

**Quoting stops 20 seconds before the bell.** In the last seconds the fair price
is converging on 0 or 1 while a resting quote is not. Anything filled there is
adverse selection by construction.

## Why the ladder is anchored to round numbers

`strikeLadder` snaps to a fixed dollar grid — $50 for BTC — rather than deriving
strikes from live spot each run.

The roller runs every minute against a moving price. A ladder computed from spot
would produce a slightly different set of strikes every pass, and the board would
fill with near-duplicate rows each holding one column and a gap everywhere else.
Anchoring means consecutive runs reuse the same strikes and a row is a row all the
way across.

The step is chosen against the distribution, not for tidiness: at 30% annualised
vol a five-minute BTC move has a standard deviation near 9 bps, so a 5 bps step
puts the outer rows of a 7-row ladder at roughly 1.6σ. Wider and the edge rows
print 0.99 and nobody trades them; tighter and every row is the same bet.
`ladderStepUsd` converts that to the nearest round dollar amount.

## Market parameters

Set once in `PitFactory`'s constructor and applied to every market it lists:

| Parameter        | Value  | Why                                                          |
| ---------------- | ------ | ------------------------------------------------------------ |
| `pricePrecision` | 1e6    | a leg trades in [0, 1]; 1.0 is 1e6, inside `uint32`           |
| `tickSize`       | 1000   | 0.001 collateral — 10 bps of probability                      |
| `sizePrecision`  | 1e6    | matches the collateral's 6 decimals, so a contract is a token |
| `minSize`        | 1e6    | one contract: costs at most 1, pays at most 1                 |
| `takerFeeBps`    | 0      | the demo is about the book, not the rake                      |
| `makerFeeBps`    | 0      | same                                                          |
| `kuruAmmSpread`  | 500    | the widest allowed; Pit never funds the Kuru AMM vault       |

`deployProxy` always creates a vault alongside the book. Pit never funds it, so
it holds no inventory and quotes nothing — every price on a Pit book came from a
human or a script that anyone could run.

## What is not solved yet

**The maker is one account.** It is a script with a hot key on testnet, and it
will lose money to anyone with a faster price feed. Week 2 of the roadmap is
quoting off the book's own imbalance rather than a flat model, plus inventory
skew across the two legs, plus a public P&L page for that account. If the maker
cannot survive being adversely selected, nothing built on top of it matters.

**Nobody else has a reason to quote yet.** Zero fees means zero maker rebate. The
honest answer is that the first external makers will come for the flow, not the
rebate, and that has to be earned by having flow.
