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

/**
 * Ladder offsets in basis points of spot, centre first.
 *
 * Centre (0 bps) is the up/down cell. The others are the above/below rows.
 *
 * The step is chosen against the actual distribution, not for round numbers: at a
 * 30% annualised vol a five-minute BTC move has a standard deviation near 9 bps,
 * so a 5 bps step puts the outer rows at roughly 1.6 sigma. Wider and the edge
 * rows print 0.99 and nobody trades them; tighter and every row is the same bet.
 */
export const DEFAULT_LADDER_BPS = [15, 10, 5, 0, -5, -10, -15] as const;

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
 * Strike ladder around `spotE8`, snapped to whole dollars so the labels a trader
 * reads are the numbers the contract stores.
 */
export function strikeLadder(spotE8: bigint, ladderBps: readonly number[] = DEFAULT_LADDER_BPS): bigint[] {
  return ladderBps.map((bps) => {
    const shifted = (spotE8 * BigInt(10_000 + bps)) / 10_000n;
    return roundStrikeE8(shifted);
  });
}

/** Snap a strike to the nearest whole dollar (1e8 units). */
export function roundStrikeE8(strikeE8: bigint): bigint {
  const half = PRICE_E8 / 2n;
  return ((strikeE8 + half) / PRICE_E8) * PRICE_E8;
}

export function usdToE8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

export function e8ToUsd(e8: bigint): number {
  return Number(e8) / 1e8;
}

/** Mirrors `CellFactory.windowKey` so scripts and UI can address a cell offline. */
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
