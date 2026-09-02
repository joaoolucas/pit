/**
 * Kuru price and size conversions for Pit markets.
 *
 * Kuru stores a price as `uint32` in `pricePrecision` units and a size as
 * `uint96` in `sizePrecision` units. Every Pit market is listed with the same
 * parameters, because every outcome leg trades in the same [0, 1] range — so
 * these conversions are constants rather than per-market lookups.
 *
 * Kept in sync with `PitFactory.marketConfig` (see constructor).
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

// ---------------------------------------------------------------------------
// Money, the way a prediction market says it
//
// Every venue a trader already uses — Kalshi, Polymarket — prices a binary in
// whole cents and sizes an order in dollars. "62¢" and "$25" are the units; a
// contract count is an implementation detail the interface should compute, not
// ask for. Pit speaks the same way at the edges and keeps ticks and sizes
// internally, where the contracts need them.
// ---------------------------------------------------------------------------

/** A Kuru tick as whole cents. 620000 -> 62. */
export function tickToCents(tick: bigint | number): number {
  return Math.round(tickToProb(tick) * 100);
}

/** Whole cents as a Kuru tick, snapped to the tick grid. 62 -> 620000n. */
export function centsToTick(cents: number): bigint {
  return probToTick(cents / 100);
}

export function formatCents(cents: number): string {
  return `${Math.round(cents)}¢`;
}

/**
 * What a dollar amount buys at a price, in whole contracts.
 *
 * Floored, never rounded: a ticket that quietly asks for more than the amount
 * typed is a ticket nobody trusts twice.
 */
export function contractsForDollars(dollars: number, priceCents: number): number {
  if (!Number.isFinite(dollars) || !Number.isFinite(priceCents)) return 0;
  if (dollars <= 0 || priceCents <= 0) return 0;
  return Math.floor((dollars * 100) / priceCents);
}

/** What an order actually spends and pays, once the size is a whole number. */
export type Ticket = {
  /** Whole contracts the order is for. */
  contracts: number;
  /** Dollars committed. Never more than the amount asked for. */
  spend: number;
  /** Dollars back if the leg wins. One per contract. */
  toWin: number;
  /** Profit on top of the spend. */
  profit: number;
  /** Return on risk, the number that goes on the tile. */
  multiple: number;
};

export function priceTicket(dollars: number, priceCents: number): Ticket | null {
  const contracts = contractsForDollars(dollars, priceCents);
  if (contracts <= 0) return null;

  const spend = (contracts * priceCents) / 100;
  const toWin = contracts;

  return {
    contracts,
    spend,
    toWin,
    profit: toWin - spend,
    multiple: spend === 0 ? Infinity : toWin / spend,
  };
}

/** The payout multiple on a tile: 62¢ -> 1.6x. */
export function multipleFromCents(cents: number): number {
  return cents <= 0 ? Infinity : 100 / cents;
}

/**
 * The multiple as a tile wants it: one decimal while it is small enough to
 * matter, none once it is large, and never "1.0x" for a market at 99¢ that
 * pays a cent.
 */
export function formatMultiple(cents: number): string {
  const multiple = multipleFromCents(cents);
  if (!Number.isFinite(multiple)) return "—";
  if (multiple >= 10) return `${Math.round(multiple)}x`;
  // Two decimals, then drop the ones that carry nothing: 2.00 reads "2x",
  // 1.60 reads "1.6x", 1.61 keeps both.
  return `${Number(multiple.toFixed(2))}x`;
}

// ---------------------------------------------------------------------------
// How a tile reads
//
// Two facts decide whether a cell is worth a click, and the board has to carry
// both at a glance: what the book believes, and whether there is anything
// behind that belief. So the tile gets two channels.
//
//   hue        which side, pulled toward neutral by how even the market is —
//              a 52 and a 94 must never be the same shade
//   presence   how much size is resting, relative to the deepest cell on the
//              board. Nothing resting means nothing painted.
//
// The number on the tile already says the price. The paint says where the
// liquidity is, which is the one thing a payout tile can never tell you.
// ---------------------------------------------------------------------------

export type TileInk = {
  side: "yes" | "no" | "none";
  /** 0 at an even market, 1 at certainty. */
  conviction: number;
  /** 0 when nothing is resting, 1 at the deepest cell on the board. */
  presence: number;
};

export function tileInk(cents: number | null, depth: bigint, maxDepth: bigint): TileInk {
  if (cents === null) return { side: "none", conviction: 0, presence: 0 };

  const clamped = Math.min(Math.max(cents, 0), 100);
  const side = clamped >= 50 ? "yes" : "no";
  const conviction = Math.abs(clamped - 50) / 50;

  // Square-rooted, so a cell holding a tenth of the deepest book still reads as
  // tradeable rather than as an empty one.
  const ratio = maxDepth > 0n && depth > 0n ? Number(depth) / Number(maxDepth) : 0;
  const presence = Math.sqrt(Math.min(Math.max(ratio, 0), 1));

  return { side, conviction, presence };
}
