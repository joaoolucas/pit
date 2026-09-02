import type { Outcome, Side } from "@cell/core";
import type { RawCellState } from "@/lib/indexer";

/**
 * One tile on the board.
 *
 * A window has two Kuru markets — YES and NO — and both are kept here, because
 * the honest read of a cell's probability sometimes comes from the leg that
 * actually has a book. See `impliedProbability` in Grid.tsx.
 */
export type GridCell = {
  id: string;
  windowId: number;
  endTs: number;
  strikeE8: bigint;
  outcome: Outcome;
  /** Mid of whichever leg is quoted, expressed as a YES probability. */
  impliedProbability: number | null;
  /** Half-width of the YES market, in probability. Null when one side is empty. */
  spread: number | null;
  makers: number;
  volume: bigint;
  legs: Record<Side, RawCellState | null>;
};
