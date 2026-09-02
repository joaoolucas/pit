/**
 * The grid, defined once.
 *
 * A cell is a point on two axes:
 *
 *   x — a 5-minute window, identified by the unix second it settles at (`endTs`).
 *   y — a strike, in USD scaled by 1e8.
 *
 * "5m up/down" is not a different product from "above/below": it is the row of
 * the ladder whose strike is the spot price at the moment the column was opened.
 * The contract only ever knows about strikes, which is why adding rows later is
 * a config change and not a rewrite.
 */

/** Every column is five minutes wide. */
export const WINDOW_SECONDS = 300;

/** Price scale used everywhere a USD price crosses a contract boundary. */
export const PRICE_E8 = 100_000_000n;

export type Underlying = "BTC-USD" | "ETH-USD";

/** Columns rendered ahead of the live one. Eight columns is 40 minutes of tape. */
export const DEFAULT_COLUMNS = 8;

/** Rows on the board. Odd, so there is a middle. */
export const DEFAULT_LADDER_ROWS = 7;

/**
 * Row spacing, in basis points of spot.
 *
 * Chosen against the actual distribution rather than for round numbers: at a 30%
 * annualised vol a five-minute BTC move has a standard deviation near 9 bps, so
 * a 5 bps step puts the outer rows of a 7-row ladder at roughly 1.6 sigma. Wider
 * and the edge rows print 0.99 and nobody trades them; tighter and every row is
 * the same bet.
 */
export const DEFAULT_LADDER_STEP_BPS = 5;

/** Start of the 5-minute window containing `unixSeconds`. */
export function windowStart(unixSeconds: number, size = WINDOW_SECONDS): number {
  return Math.floor(unixSeconds / size) * size;
}

/** End of the 5-minute window containing `unixSeconds`. */
export function windowEnd(unixSeconds: number, size = WINDOW_SECONDS): number {
  return windowStart(unixSeconds, size) + size;
}

/** The `endTs` of the live column plus the next `count - 1` columns. */
export function upcomingWindowEnds(nowSeconds: number, count = DEFAULT_COLUMNS, size = WINDOW_SECONDS): number[] {
  const first = windowEnd(nowSeconds, size);
  return Array.from({ length: count }, (_, i) => first + i * size);
}

/** Seconds until a window closes. Negative once it has closed. */
export function secondsLeft(endTs: number, nowSeconds: number): number {
  return endTs - nowSeconds;
}

/**
 * Round step sizes, in whole dollars.
 *
 * The ladder snaps to one of these rather than to whatever `spot * stepBps`
 * happens to be, and that matters more than it looks: the roller runs every
 * minute against a moving spot, and a ladder derived from the live price would
 * produce a slightly different set of strikes every run. The board would then
 * fill with near-duplicate rows, each holding one column and a gap everywhere
 * else. Anchoring to a fixed grid means consecutive runs reuse the same strikes,
 * so a row is a row all the way across.
 */
const NICE_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];

/** The dollar spacing a ladder around `spotE8` should use. */
export function ladderStepUsd(spotE8: bigint, stepBps = DEFAULT_LADDER_STEP_BPS): number {
  const raw = (e8ToUsd(spotE8) * stepBps) / 10_000;
  let best = NICE_STEPS[0]!;
  for (const step of NICE_STEPS) {
    if (Math.abs(step - raw) < Math.abs(best - raw)) best = step;
  }
  return best;
}

/**
 * Strike ladder around `spotE8`, highest first, anchored to a fixed dollar grid.
 *
 * The middle row is the strike nearest spot — the "up/down" cell — and the rest
 * are the above/below rows. Because the grid is absolute rather than relative to
 * the current price, the same strike keeps its row as spot drifts.
 */
export function strikeLadder(
  spotE8: bigint,
  rows = DEFAULT_LADDER_ROWS,
  stepBps = DEFAULT_LADDER_STEP_BPS,
): bigint[] {
  const step = ladderStepUsd(spotE8, stepBps);
  const stepE8 = usdToE8(step);
  const anchor = (spotE8 + stepE8 / 2n) / stepE8; // nearest grid line, in steps
  const half = Math.floor(rows / 2);

  return Array.from({ length: rows }, (_, i) => (anchor + BigInt(half - i)) * stepE8);
}

/** Snap a strike to the nearest whole dollar (1e8 units). */
export function roundStrikeE8(strikeE8: bigint): bigint {
  const half = PRICE_E8 / 2n;
  return ((strikeE8 + half) / PRICE_E8) * PRICE_E8;
}

/**
 * Where a price sits on the ladder, in row units measured from the top edge.
 *
 * `offset` 0.5 is the centre of the first row, 1.5 the centre of the second, so
 * a renderer multiplies by its row height and is done.
 *
 * The `on` tag exists because the interesting case is the price leaving the
 * ladder entirely. A board whose price line has silently vanished is worse than
 * one that says "the price is above every strike here" — the first looks broken,
 * the second is information, and the roller recentring on its next pass fixes it
 * either way.
 */
export type LadderLocation =
  | { readonly on: "ladder"; readonly offset: number }
  | { readonly on: "above"; readonly offset: 0 }
  | { readonly on: "below"; readonly offset: number };

export function locateOnLadder(strikesE8: readonly bigint[], priceE8: bigint): LadderLocation | null {
  if (strikesE8.length === 0) return null;

  const values = strikesE8.map(e8ToUsd);
  const price = e8ToUsd(priceE8);
  const top = values[0]!;
  const bottom = values[values.length - 1]!;

  if (price > top) return { on: "above", offset: 0 };
  if (price < bottom) return { on: "below", offset: values.length };

  for (let i = 0; i < values.length - 1; i++) {
    const upper = values[i]!;
    const lower = values[i + 1]!;
    if (price <= upper && price >= lower) {
      const fraction = upper === lower ? 0 : (upper - price) / (upper - lower);
      return { on: "ladder", offset: i + 0.5 + fraction };
    }
  }

  // A single-row ladder, or a price exactly on the only strike.
  return { on: "ladder", offset: 0.5 };
}

export function usdToE8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

export function e8ToUsd(e8: bigint): number {
  return Number(e8) / 1e8;
}

/** Mirrors `PitFactory.windowKey` so scripts and UI can address a cell offline. */
export type CellCoords = {
  underlying: Underlying;
  endTs: number;
  strikeE8: bigint;
};

/** A stable client-side key for a cell, independent of whether it exists onchain yet. */
export function cellKey({ underlying, endTs, strikeE8 }: CellCoords): string {
  return `${underlying}:${endTs}:${strikeE8.toString()}`;
}

export function formatClock(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "0:00";
  const m = Math.floor(secondsRemaining / 60);
  const s = secondsRemaining % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatStrike(strikeE8: bigint): string {
  return e8ToUsd(strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Rough fair probability that the underlying finishes above `strikeE8`.
 *
 * A driftless lognormal over the remaining life of the window. This is not a
 * pricing engine and is not used to settle anything — it seeds the maker's
 * quotes and gives the UI a reference line to show next to the actual book, so
 * a trader can see immediately where the book disagrees with a flat model.
 */
export function fairProbabilityAbove(
  spotE8: bigint,
  strikeE8: bigint,
  secondsRemaining: number,
  annualisedVol: number,
): number {
  if (secondsRemaining <= 0) return spotE8 > strikeE8 ? 1 : 0;
  const spot = e8ToUsd(spotE8);
  const strike = e8ToUsd(strikeE8);
  if (spot <= 0 || strike <= 0) return 0.5;

  const years = secondsRemaining / (365 * 24 * 60 * 60);
  const sigma = annualisedVol * Math.sqrt(years);
  if (sigma <= 0) return spot > strike ? 1 : 0;

  // P(S_T > K) under a driftless GBM, i.e. N(d2) with mu = 0.
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma) / sigma;
  return normalCdf(d2);
}

/** Abramowitz & Stegun 7.1.26 — accurate to ~1e-7, which is far past a 0.001 tick. */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * The rows worth showing, centred on the price.
 *
 * The roller opens a fresh ladder every minute, so over an hour the union of
 * strikes across the visible columns grows well past what fits on a screen — and
 * the ones far from spot are the ones nobody trades. This keeps the window of
 * rows around the money and drops the rest, which is what an option chain does
 * when a trader asks for "ten strikes either side".
 *
 * `strikesE8` must be sorted highest first, which is how the board renders them.
 */
export function visibleStrikes(
  strikesE8: readonly bigint[],
  spotE8: bigint | null,
  rows = DEFAULT_LADDER_ROWS + 2,
): bigint[] {
  if (strikesE8.length <= rows) return [...strikesE8];
  if (spotE8 === null) return strikesE8.slice(0, rows);

  // The row nearest the price, then a window centred on it.
  let nearest = 0;
  let best = -1n;
  for (let i = 0; i < strikesE8.length; i++) {
    const strike = strikesE8[i]!;
    const distance = strike > spotE8 ? strike - spotE8 : spotE8 - strike;
    if (best < 0n || distance < best) {
      best = distance;
      nearest = i;
    }
  }

  const half = Math.floor(rows / 2);
  const start = Math.min(Math.max(nearest - half, 0), strikesE8.length - rows);
  return strikesE8.slice(start, start + rows);
}
