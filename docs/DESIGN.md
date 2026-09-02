# Design

## The thesis

Pit is not a chart with tiles on it. **Pit is an option chain for five-minute
binaries.**

Strikes down one axis, expiries across the other, prices in the cells: that
instrument is a century old and every derivatives trader reads it without being
taught. Nobody had built one for short-horizon binaries because the windows
expire faster than the chain can be quoted. On Monad they can, so the layout is
not a metaphor — it is the product.

Everything else in this document follows from that sentence.

## What the competition looks like

| | Grid Arena | Polymarket 5m | Outrive | Pit |
| --- | --- | --- | --- | --- |
| Board shape | time × direction (2 rows), *or* a 1-column strike ladder | one up/down market per window | a chat room | **time × strike, together** |
| The book | "no depth" | off-chain matching, on-chain settlement | — | **a public onchain CLOB anyone can quote on** |
| Can you make? | no | via their API | no | **yes, from the panel** |
| Who you trade against | the venue | whoever the matcher paired you with | the room | **an address on your screen** |

Grid Arena's structure is right and this design borrows it: one continuous
canvas, price on the left, markets on the right, price axis on the far right,
payout multiple as the headline number. Their entry ergonomics are right too —
dollars, cents, quick-add chips, "to win" — and market-standard, so Pit speaks
the same way.

Where Pit diverges is the half nobody else has: a real book per leg. That is
what the visual language is built to show.

## Palette — "sounding"

The ground is water, not black.

```
--color-deep      #08151C   the water column, darkest at the edges
--color-hull      #0C1C25   panels
--color-raised    #112832   book rows, the to-win box
--color-rule      #1A3541   hairlines
--color-foam      #E8F3F5   type, cool white because the ground is cool
--color-yes       #34E0A1   mint
--color-no        #FF5C7A   rose
--color-live      #FFC24B   time running out — the only warm colour on screen
--color-trace     #7FDBFF   the price, never green or red
```

`#08151C` is a dark blue-green, the colour of a depth sounder, and it is the
reason the mint and rose sit quietly instead of vibrating the way neon does on
neutral black. It is also not the near-black-plus-one-acid-accent that every
trading UI reaches for.

Two constraints held the palette honest. Green means YES and red means NO,
because that is not a place to be original — it is the convention every user
already has in their hands. And the price gets its own hue, so a line on the
chart can never be mistaken for a position.

The scale between them is **diverging, anchored at 50¢**, not two flat
categories. A binary price has a meaningful centre, so a 52 and a 94 must not be
the same shade — and a diverging colormap is simply the correct encoding for a
value with a midpoint.

## Type

Three faces, three jobs, and none of them Inter.

| Role | Face | Why |
| --- | --- | --- |
| Readout | **Martian Mono** 500/600 | Wide and mechanical. Only the numbers that carry a decision: the multiple on a tile, spot, the clock. Never inside a table. |
| Data | **IBM Plex Mono** | The book and the tape, where tabular figures and a narrow advance matter more than character. |
| Labels | **IBM Plex Sans Condensed** | A dense board needs its words to take less room than its numbers. |

Martian Mono is the risk. It is too wide for body text and would be a mistake
almost anywhere else, which is exactly why it is memorable here: a `2.5x` set in
it looks machined, and it appears in only three places.

## The signature: depth is the material

Each tile carries two facts in two channels.

- **Hue** — which side, pulled toward neutral by how even the market is.
- **Fill intensity** — how much size is resting, relative to the deepest cell on
  the board.

So a bright saturated tile is a market that is both confident and liquid; a pale
one is confident but thin; and a cell nobody quotes is **drawn hollow** — an
outline, not a tile.

That last part is the one real risk in this design. A board that is half hollow
looks broken to a designer. It reads perfectly to a trader, because it is the one
thing a payout tile can never tell you: where you can actually trade. Grid Arena
prints the words "no depth" in the cell; here depth is the material the board is
made of.

The encoding lives in `tileInk` in `@pit/core`, with tests, because it is a
claim about the data and not a styling detail.

## The panel: a spine, and the number nobody else can show

The cell panel opens with the spine of an option chain — **YES · strike · NO** on
one line — because the only economic fact that matters here is that the two legs
are two halves of one dollar.

Under it sits a line that only exists because these are two *independent* books:

```
41¢ + 61¢ = 102¢          2¢ of spread across both legs
97¢ + 2¢  =  99¢          buy both legs and lock 1¢
```

Over a dollar it is the overround — the spread you pay on each leg. Under a
dollar it is a **risk-free trade sitting on the screen**: buy both legs for 99¢
and redeem 100¢ whichever way the price goes. An AMM would never let that happen.
Two order books do, and this line is the only place anyone would notice.

## The ticket: two people, two units

Split by who is using it, because takers and makers do not think in the same
units.

**Take** is dollars in, dollars back — the path a tape trader wants, two taps
deep. `$25` with `+5 / +25 / +100` chips, prices in whole cents, and **TO WIN**
as the largest number in the panel. This is deliberately the same shape Kalshi,
Polymarket and Grid Arena use; a trader should not have to learn a new ticket to
try a new venue.

**Make** is a price and a size, which is what someone posting a quote actually
decides. It is the half no payout tile can offer: on Pit you can be the one
collecting the spread. Post-only by default, so a quote meant to rest can never
accidentally cross.

## Motion

Almost none, and all of it load-bearing.

- The chain **sweeps in** left to right, once, 340ms with a 45ms stagger per
  column. A board of markets that are all counting down should look like it was
  scanned into place.
- The live column's head carries a **progress bar** that fills across its five
  minutes. It is the difference between "plenty of time" and "decide now".
- The trace has a **wake**: recent price at full strength, older minutes fading,
  because on a five-minute market the last thirty seconds carry most of the
  information. That is a gradient, not an animation.

`prefers-reduced-motion` kills the sweep and the flash.

## Words

Every action names what happens and keeps that name: the button says **Buy YES
at 62¢** and the confirmation says **Bought 40 YES at 62¢**. Nothing says
"Submit".

Empty states are instructions. "The book is empty" is followed by "post a price
on the Make tab and you are the first quote on this cell", because on this
product that is genuinely available to the reader.

And numbers say what they are. The ticket used to print "max payout" on a sell,
which is the *buyer's* number — a seller collects the premium and owes the
notional. It now says **max loss** and **premium received**, and the arithmetic
lives in `payoff` in `@pit/core` next to its tests.

## What was tried and rejected

- **A quick-buy popover anchored to the cell**, like Grid Arena's. Better at
  keeping the board visible, worse for us: the book, the tape and the makers do
  not fit in a popover, and they are the reason to be here. The panel is docked
  and the board stays legible beside it.
- **The strike axis on the left.** It is where a spreadsheet puts it. A chart
  puts the price scale on the right, and this surface is more chart than
  spreadsheet.
- **Cells for the settled past.** The trace covers the past now, so old columns
  were dead weight. One settled column stays, immediately left of the live one,
  because the most recent settle is the proof that settlement happens at all.
- **Depth printed as a number on the tile.** Three numbers per tile stops anyone
  reading the first. The paint says it.
- **The word "SETTLING" down a whole column.** A dot says it once per cell.
