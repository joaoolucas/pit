/**
 * Kuru price and size conversions for Cell markets.
 *
 * Kuru stores a price as `uint32` in `pricePrecision` units and a size as
 * `uint96` in `sizePrecision` units. Every Cell market is listed with the same
 * parameters, because every outcome leg trades in the same [0, 1] range — so
 * these conversions are constants rather than per-market lookups.
 *
 * Kept in sync with `CellFactory.marketConfig` (see constructor).
 */

export const SIZE_PRECISION = 1_000_000n;
export const PRICE_PRECISION = 1_000_000n;
/** 0.001 collateral == 10 bps of probability. */
export const TICK_SIZE = 1_000n;
/** One contract: costs at most 1 collateral, pays at most 1. */
export const MIN_SIZE = 1_000_000n;
export const MAX_SIZE = 100_000_000_000_000n;

export const MARKET_CONFIG = {
  sizePrecision: SIZE_PRECISION,
  pricePrecision: PRICE_PRECISION,
  tickSize: TICK_SIZE,
  minSize: MIN_SIZE,
  maxSize: MAX_SIZE,
  takerFeeBps: 0n,
  makerFeeBps: 0n,
  kuruAmmSpread: 500n,
} as const;

/** Probability in [0, 1] -> a Kuru tick. Always lands on the tick grid. */
export function probToTick(probability: number): bigint {
  const clamped = Math.min(Math.max(probability, 0), 1);
  const raw = BigInt(Math.round(clamped * Number(PRICE_PRECISION)));
  const snapped = (raw / TICK_SIZE) * TICK_SIZE;
  // Never quote at 0 or at 1: those are not prices, they are claims.
  const min = TICK_SIZE;
  const max = PRICE_PRECISION - TICK_SIZE;
  return snapped < min ? min : snapped > max ? max : snapped;
}

/** A Kuru tick -> probability in [0, 1]. */
export function tickToProb(tick: bigint | number): number {
  return Number(tick) / Number(PRICE_PRECISION);
}

/** Contracts (as a trader says them) -> a Kuru size. */
export function contractsToSize(contracts: number): bigint {
  return BigInt(Math.round(contracts * Number(SIZE_PRECISION)));
}

/** A Kuru size -> contracts. */
export function sizeToContracts(size: bigint | number): number {
  return Number(size) / Number(SIZE_PRECISION);
}

/**
 * Collateral a resting order locks, in the collateral token's own base units.
 *
 * A buy locks `size * price`; a sell locks the outcome tokens themselves, which
 * is `size` scaled to the token's decimals.
 */
export function quoteCost(size: bigint, tick: bigint, collateralDecimals: number): bigint {
  return (size * tick * 10n ** BigInt(collateralDecimals)) / (SIZE_PRECISION * PRICE_PRECISION);
}

export function baseCost(size: bigint, outcomeDecimals: number): bigint {
  return (size * 10n ** BigInt(outcomeDecimals)) / SIZE_PRECISION;
}

/** What a filled order is worth if the leg wins: one collateral unit per contract. */
export function maxPayout(size: bigint, collateralDecimals: number): bigint {
  return baseCost(size, collateralDecimals);
}

/** Percent return if the leg settles in the money, given an entry tick. */
export function payoffMultiple(tick: bigint | number): number {
  const p = tickToProb(tick);
  if (p <= 0) return Infinity;
  return 1 / p;
}

export function formatProbability(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

export function formatTickAsPrice(tick: bigint | number): string {
  return tickToProb(tick).toFixed(3);
}

/**
 * What an order actually costs and pays.
 *
 * Buying and selling a binary are not mirror images, and stating them as if they
 * were is the easiest way to put a wrong number in front of someone:
 *
 *   buy  q at p — pay p·q, receive q if the leg wins. Risk is what you paid.
 *   sell q at p — collect p·q now, owe q if the leg wins. Risk is (1 − p)·q,
 *                 and the profit is the premium, not the notional.
 *
 * `price` is a probability in (0, 1) and `size` is contracts. Both are plain
 * numbers because this feeds a form, not a transaction — the order that goes to
 * Kuru is built from the same strings the user typed.
 */
export type Payoff = {
  /** The most this order can lose. */
  risk: number;
  /** What arrives if the leg finishes in the money. */
  proceeds: number;
  /** proceeds minus what was paid for them. */
  profit: number;
  /** Return on risk, e.g. 1.9 for a leg bought at 0.53. */
  multiple: number;
};

export function payoff(price: number, size: number, isBuy: boolean): Payoff | null {
  if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
  if (price <= 0 || price >= 1 || size <= 0) return null;

  const risk = isBuy ? price * size : (1 - price) * size;
  const proceeds = isBuy ? size : price * size;
  const profit = isBuy ? size - price * size : price * size;

  return { risk, proceeds, profit, multiple: risk === 0 ? Infinity : proceeds / risk };
}
