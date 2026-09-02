/**
 * The shared arithmetic, checked.
 *
 * Everything here is imported by the contracts scripts, the indexer and the web
 * app, so a mistake in this file is a mistake in three places at once — and two
 * of them are numbers a trader reads before risking money.
 *
 *   node --experimental-strip-types --test test/core.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";


import {
  centsToTick,
  contractsToSize,
  formatCents,
  formatMultiple,
  priceTicket,
  tickToCents,
  tileInk,
  MARKET_CONFIG,
  payoff,
  probToTick,
  quoteCost,
  sizeToContracts,
  tickToProb,
} from "../src/kuru.ts";
import {
  e8ToUsd,
  fairProbabilityAbove,
  ladderStepUsd,
  locateOnLadder,
  strikeLadder,
  upcomingWindowEnds,
  usdToE8,
  visibleStrikes,
  windowEnd,
  windowStart,
  WINDOW_SECONDS,
} from "../src/windows.ts";

/** Money in this file is a float on its way to toFixed(2), so compare to a cent. */
const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} !~ ${expected}`);


// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test("windows snap to five-minute boundaries", () => {
  const noon = 1_788_355_200; // an exact boundary
  assert.equal(windowStart(noon), noon);
  assert.equal(windowEnd(noon), noon + WINDOW_SECONDS);

  // One second in is still the same window.
  assert.equal(windowStart(noon + 1), noon);
  assert.equal(windowEnd(noon + 1), noon + WINDOW_SECONDS);

  // One second before the close is still this window.
  assert.equal(windowEnd(noon + WINDOW_SECONDS - 1), noon + WINDOW_SECONDS);
});

test("the visible columns start at the live window and step forward", () => {
  const noon = 1_788_355_200;
  const ends = upcomingWindowEnds(noon + 30, 4);
  assert.deepEqual(ends, [
    noon + 300,
    noon + 600,
    noon + 900,
    noon + 1200,
  ]);
});

// ---------------------------------------------------------------------------
// The strike ladder
// ---------------------------------------------------------------------------

test("the ladder is anchored, so a minute of drift does not move the rows", () => {
  const spot = usdToE8(76_841);
  const a = strikeLadder(spot);
  const b = strikeLadder(spot + usdToE8(3));
  const c = strikeLadder(spot - usdToE8(4));

  assert.deepEqual(a, b, "a few dollars of drift must not renumber the board");
  assert.deepEqual(a, c);
});

test("the ladder uses round dollar steps and is ordered high to low", () => {
  const spot = usdToE8(76_841);
  assert.equal(ladderStepUsd(spot), 50);

  const rows = strikeLadder(spot).map(e8ToUsd);
  assert.deepEqual(rows, [77_000, 76_950, 76_900, 76_850, 76_800, 76_750, 76_700]);

  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i]! < rows[i - 1]!, "strikes must descend");
    assert.equal(rows[i - 1]! - rows[i]!, 50, "every gap is one step");
  }
});

test("the ladder scales with the underlying", () => {
  // A $2,500 asset should not get $50 rows.
  assert.ok(ladderStepUsd(usdToE8(2_500)) < 50);
  // Nor should a $95,000 one get $1 rows.
  assert.ok(ladderStepUsd(usdToE8(95_000)) >= 25);
});

test("the middle row is the one nearest spot", () => {
  const spot = usdToE8(76_841);
  const rows = strikeLadder(spot, 7);
  const middle = rows[3]!;
  for (const row of rows) {
    const distance = row > spot ? row - spot : spot - row;
    const middleDistance = middle > spot ? middle - spot : spot - middle;
    assert.ok(middleDistance <= distance, "no row is closer to spot than the middle");
  }
});

// ---------------------------------------------------------------------------
// Kuru conversions
// ---------------------------------------------------------------------------

test("probabilities round-trip through Kuru ticks", () => {
  assert.equal(probToTick(0.42), 420_000n);
  assert.equal(tickToProb(420_000n), 0.42);
  assert.equal(probToTick(0.5295), 529_000n, "snapped down to the tick grid");
});

test("a tick is always on the grid and never 0 or 1", () => {
  for (const p of [-1, 0, 0.0001, 0.5, 0.9999, 1, 2]) {
    const tick = probToTick(p);
    assert.equal(tick % MARKET_CONFIG.tickSize, 0n, `${p} landed off the tick grid`);
    assert.ok(tick >= MARKET_CONFIG.tickSize, `${p} quoted at zero`);
    assert.ok(tick <= MARKET_CONFIG.pricePrecision - MARKET_CONFIG.tickSize, `${p} quoted at one`);
  }
});

test("sizes round-trip through contracts", () => {
  assert.equal(contractsToSize(100), 100_000_000n);
  assert.equal(sizeToContracts(100_000_000n), 100);
});

test("a resting bid locks price times size, in the collateral's own units", () => {
  // 100 contracts at 0.42 is $42, and USDC has 6 decimals.
  assert.equal(quoteCost(contractsToSize(100), probToTick(0.42), 6), 42_000_000n);
  // The whole book at 1.0 would be the full notional.
  assert.equal(quoteCost(contractsToSize(100), 1_000_000n, 6), 100_000_000n);
});

// ---------------------------------------------------------------------------
// Payoff — the numbers a trader reads before pressing the button
// ---------------------------------------------------------------------------

test("buying: you risk what you pay and receive the notional", () => {
  const p = payoff(0.42, 100, true)!;
  close(p.risk, 42);
  close(p.proceeds, 100);
  close(p.profit, 58);
  assert.ok(Math.abs(p.multiple - 100 / 42) < 1e-9);
});

test("selling: you risk the other side and keep the premium", () => {
  const p = payoff(0.42, 100, false)!;
  close(p.risk, 58, "if the leg wins you owe 100 having taken 42");
  close(p.proceeds, 42, "the premium is what arrives, not the notional");
  close(p.profit, 42);
});

test("the two sides of the same trade account for the whole contract", () => {
  const buy = payoff(0.42, 100, true)!;
  const sell = payoff(0.42, 100, false)!;
  // One side's maximum gain is the other's maximum loss.
  close(buy.profit, sell.risk);
  close(sell.profit, buy.risk);
});

test("payoff refuses prices that are not prices", () => {
  for (const bad of [0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(payoff(bad, 100, true), null, `${bad} should not price`);
  }
  assert.equal(payoff(0.5, 0, true), null);
  assert.equal(payoff(0.5, -10, true), null);
});

// ---------------------------------------------------------------------------
// The reference price the maker quotes around
// ---------------------------------------------------------------------------

test("fair probability behaves like a probability", () => {
  const spot = usdToE8(76_800);
  const vol = 0.3;

  const atTheMoney = fairProbabilityAbove(spot, spot, 300, vol);
  assert.ok(atTheMoney > 0.45 && atTheMoney < 0.55, "at the money is near a coin flip");

  const above = fairProbabilityAbove(spot, usdToE8(76_900), 300, vol);
  const below = fairProbabilityAbove(spot, usdToE8(76_700), 300, vol);
  assert.ok(above < atTheMoney, "a higher strike is less likely");
  assert.ok(below > atTheMoney, "a lower strike is more likely");
  assert.ok(above > 0 && below < 1);
});

test("fair probability collapses to the outcome once the window closes", () => {
  const spot = usdToE8(76_800);
  assert.equal(fairProbabilityAbove(spot, usdToE8(76_700), 0, 0.3), 1);
  assert.equal(fairProbabilityAbove(spot, usdToE8(76_900), 0, 0.3), 0);
});

test("more time left means more uncertainty", () => {
  const spot = usdToE8(76_800);
  const strike = usdToE8(76_900);
  const soon = fairProbabilityAbove(spot, strike, 30, 0.3);
  const later = fairProbabilityAbove(spot, strike, 300, 0.3);
  assert.ok(later > soon, "an out-of-the-money strike gets likelier with more time");
});

// ---------------------------------------------------------------------------
// Placing the price on the board
// ---------------------------------------------------------------------------

test("a price inside the ladder lands in the right row", () => {
  const strikes = strikeLadder(usdToE8(76_841)); // 77000 .. 76700, $50 apart

  // The centre of the top row.
  assert.deepEqual(locateOnLadder(strikes, usdToE8(77_000)), { on: "ladder", offset: 0.5 });
  // Halfway between the top two strikes is the boundary between rows 0 and 1.
  assert.deepEqual(locateOnLadder(strikes, usdToE8(76_975)), { on: "ladder", offset: 1 });
  // The centre of the second row.
  assert.deepEqual(locateOnLadder(strikes, usdToE8(76_950)), { on: "ladder", offset: 1.5 });
  // The bottom row's centre is the last row.
  assert.deepEqual(locateOnLadder(strikes, usdToE8(76_700)), { on: "ladder", offset: 6.5 });
});

test("a price off the ladder says so instead of disappearing", () => {
  const strikes = strikeLadder(usdToE8(76_841));

  const above = locateOnLadder(strikes, usdToE8(78_000))!;
  assert.equal(above.on, "above");
  assert.equal(above.offset, 0, "clamps to the top edge so a marker can still be drawn");

  const below = locateOnLadder(strikes, usdToE8(70_000))!;
  assert.equal(below.on, "below");
  assert.equal(below.offset, strikes.length, "clamps to the bottom edge");
});

test("locating on an empty ladder is not an error, it is nothing", () => {
  assert.equal(locateOnLadder([], usdToE8(76_800)), null);
});

test("the offset is monotonic as the price falls", () => {
  const strikes = strikeLadder(usdToE8(76_841));
  let previous = -1;
  for (let price = 77_000; price >= 76_700; price -= 10) {
    const location = locateOnLadder(strikes, usdToE8(price))!;
    assert.equal(location.on, "ladder");
    assert.ok(location.offset > previous, `offset must grow as price falls (at ${price})`);
    previous = location.offset;
  }
});

// ---------------------------------------------------------------------------
// Cents and dollars — the units at the edge of the app
// ---------------------------------------------------------------------------

test("ticks and cents round-trip", () => {
  assert.equal(tickToCents(620_000n), 62);
  assert.equal(centsToTick(62), 620_000n);
  assert.equal(formatCents(62), "62¢");
  // A tick between cents rounds to the nearest, and never leaves the grid.
  assert.equal(tickToCents(625_000n), 63);
  assert.equal(centsToTick(63) % 1_000n, 0n);
});

test("a dollar amount buys whole contracts and never overspends", () => {
  // $25 at 62¢ buys 40 contracts and spends $24.80 — not $25.
  const ticket = priceTicket(25, 62)!;
  assert.equal(ticket.contracts, 40);
  close(ticket.spend, 24.8);
  assert.equal(ticket.toWin, 40);
  close(ticket.profit, 15.2);

  // Never rounds up past what was asked for.
  for (const dollars of [1, 3, 7, 13, 99.99]) {
    for (const cents of [1, 7, 33, 50, 62, 99]) {
      const t = priceTicket(dollars, cents);
      if (t) assert.ok(t.spend <= dollars + 1e-9, `${dollars} at ${cents} overspent`);
    }
  }
});

test("a ticket that cannot buy a single contract is not a ticket", () => {
  assert.equal(priceTicket(0.5, 62), null, "50 cents does not buy a 62 cent contract");
  assert.equal(priceTicket(0, 62), null);
  assert.equal(priceTicket(25, 0), null);
  assert.equal(priceTicket(Number.NaN, 62), null);
});

test("the multiple on a tile reads the way a trader says it", () => {
  assert.equal(formatMultiple(50), "2x", "an even market pays 2x, not 2.00x");
  assert.equal(formatMultiple(62), "1.61x");
  assert.equal(formatMultiple(63), "1.59x");
  assert.equal(formatMultiple(10), "10x");
  assert.equal(formatMultiple(1), "100x");
  assert.equal(formatMultiple(99), "1.01x");
});

// ---------------------------------------------------------------------------
// How a tile reads — the board's signature
// ---------------------------------------------------------------------------

test("a cell with no price is painted with nothing", () => {
  const ink = tileInk(null, 500n, 1_000n);
  assert.equal(ink.side, "none");
  assert.equal(ink.presence, 0, "an unpriced cell must stay hollow even if size is reported");
});

test("hue picks the side and conviction says how far from even", () => {
  assert.equal(tileInk(94, 1n, 1n).side, "yes");
  assert.equal(tileInk(6, 1n, 1n).side, "no");

  close(tileInk(50, 1n, 1n).conviction, 0, "an even market has no conviction");
  close(tileInk(100, 1n, 1n).conviction, 1);
  close(tileInk(0, 1n, 1n).conviction, 1);
  close(tileInk(75, 1n, 1n).conviction, 0.5);

  // The point of the diverging scale: these two must not look alike.
  assert.ok(tileInk(94, 1n, 1n).conviction > tileInk(52, 1n, 1n).conviction + 0.5);
});

test("presence is depth relative to the deepest cell on the board", () => {
  assert.equal(tileInk(60, 0n, 1_000n).presence, 0, "nothing resting, nothing painted");
  close(tileInk(60, 1_000n, 1_000n).presence, 1, "the deepest cell is fully present");
  // Square-rooted, so a thin book is still visible rather than invisible.
  assert.ok(tileInk(60, 100n, 10_000n).presence > 0.09);
  close(tileInk(60, 2_500n, 10_000n).presence, 0.5);
});

test("presence never leaves [0, 1], whatever the indexer reports", () => {
  for (const [depth, max] of [
    [0n, 0n],
    [5n, 0n],
    [10_000n, 100n],
    [1n, 1n],
  ] as const) {
    const { presence } = tileInk(60, depth, max);
    assert.ok(presence >= 0 && presence <= 1, `presence ${presence} out of range`);
  }
});

// ---------------------------------------------------------------------------
// Choosing which rows to show
// ---------------------------------------------------------------------------

test("a ladder that fits is shown whole", () => {
  const strikes = strikeLadder(usdToE8(77_000));
  assert.deepEqual(visibleStrikes(strikes, usdToE8(77_000), 9), strikes);
});

test("a long ladder is windowed around the price", () => {
  // Twenty strikes, $50 apart, 77,950 down to 77,000.
  const strikes = Array.from({ length: 20 }, (_, i) => usdToE8(77_950 - i * 50));

  const rows = visibleStrikes(strikes, usdToE8(77_500), 9).map(e8ToUsd);
  assert.equal(rows.length, 9);
  assert.ok(rows.includes(77_500), "the row nearest the price must be on screen");
  // Centred: four above, four below.
  assert.equal(rows[4], 77_500);
  // Still descending, still contiguous.
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i - 1]! - rows[i]!, 50);
});

test("a price at the edge of the ladder still returns a full window", () => {
  const strikes = Array.from({ length: 20 }, (_, i) => usdToE8(77_950 - i * 50));

  const high = visibleStrikes(strikes, usdToE8(79_000), 9).map(e8ToUsd);
  assert.equal(high.length, 9, "clamped to the top, not truncated");
  assert.equal(high[0], 77_950);

  const low = visibleStrikes(strikes, usdToE8(70_000), 9).map(e8ToUsd);
  assert.equal(low.length, 9, "clamped to the bottom, not truncated");
  assert.equal(low[low.length - 1], 77_000);
});

test("with no price yet, the top of the ladder is shown", () => {
  const strikes = Array.from({ length: 20 }, (_, i) => usdToE8(77_950 - i * 50));
  assert.equal(visibleStrikes(strikes, null, 9).length, 9);
});
