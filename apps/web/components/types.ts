import type { Outcome, Side } from "@pit/core";
import type { RawCellState } from "@/lib/indexer";

/**
 * One tile on the board.
 *
 * A window has two Kuru markets — YES and NO — and both are kept, because the
 * honest read of a cell's price sometimes comes from the leg that actually has a
 * book: a NO market at 38¢ tells you the YES is 62¢ even when nobody has quoted
 * the YES side at all.
 */
export type BoardCell = {
  id: string;
  windowId: number;
  endTs: number;
  strikeE8: bigint;
  outcome: Outcome;
  /** The YES price in whole cents, from whichever leg is quoted. */
  cents: number | null;
  /** Market width in cents. Null when only one side is quoted. */
  widthCents: number | null;
  /** Total size resting across both legs, in Kuru size units. Paints the tile. */
  depth: bigint;
  /** Distinct addresses with a live order. */
  makers: number;
  volume: bigint;
  /** Everything a hover should say, assembled once. */
  title: string;
  legs: Record<Side, RawCellState | null>;
};
