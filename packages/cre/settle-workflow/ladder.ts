/**
 * The grid's geometry, as the workflow needs it.
 *
 * This is a port of `@pit/core/windows`, not an import, for the same reason
 * `abi.ts` is a narrow literal: a workflow compiles to WASM and pulling a
 * workspace package into that bundle to get four pure functions is a build
 * problem in exchange for nothing. `npm run check` in this package asserts the
 * two agree on a spread of prices, so the copy cannot drift quietly — which is
 * the only thing that makes duplicating it acceptable.
 *
 * Keep the two in step by hand, and let the check tell you when you did not.
 */

/** Every column is five minutes wide. */
export const WINDOW_SECONDS = 300;

/** Row spacing, in basis points of spot. */
export const DEFAULT_LADDER_STEP_BPS = 5;

const e8ToUsd = (e8: bigint): number => Number(e8) / 1e8;
const usdToE8 = (usd: number): bigint => BigInt(Math.round(usd * 1e8));

/** The `endTs` of the live column plus the next `count - 1` columns. */
export function upcomingWindowEnds(nowSeconds: number, count: number, size = WINDOW_SECONDS): number[] {
  const first = Math.floor(nowSeconds / size) * size + size;
  return Array.from({ length: count }, (_, i) => first + i * size);
}

/**
 * Round step sizes, in whole dollars.
 *
 * The ladder snaps to one of these rather than to whatever `spot * stepBps`
 * happens to be. That matters here more than anywhere: this runs every thirty
 * seconds against a moving spot, and a ladder derived from the live price would
 * produce a slightly different set of strikes each pass. The board would fill
 * with near-duplicate rows, each holding one column and a gap everywhere else.
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
 * Because the grid is absolute rather than relative to the current price, the
 * same strike keeps its row as spot drifts — so consecutive passes reuse the
 * same strikes and a row is a row all the way across the board.
 */
export function strikeLadder(spotE8: bigint, rows: number, stepBps = DEFAULT_LADDER_STEP_BPS): bigint[] {
  const step = ladderStepUsd(spotE8, stepBps);
  const stepE8 = usdToE8(step);
  const anchor = (spotE8 + stepE8 / 2n) / stepE8; // nearest grid line, in steps
  const half = Math.floor(rows / 2);

  return Array.from({ length: rows }, (_, i) => (anchor + BigInt(half - i)) * stepE8);
}
