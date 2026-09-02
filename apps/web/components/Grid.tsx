"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { Candle } from "@/lib/usePrice";
import { e8ToUsd, formatClock, Outcome, tickToProb, WINDOW_SECONDS } from "@cell/core";
import type { GridCell } from "./types";

/** Never thinner than this, however much room there is. */
const MIN_ROW_HEIGHT = 46;

/** Width of the strike axis. The price overlay starts after it. */
const AXIS_WIDTH = 72;

type Props = {
  columns: number[];
  strikes: bigint[];
  cells: Map<string, GridCell>;
  spotE8: bigint | null;
  candles: Candle[];
  now: number;
  selectedId: string | null;
  onSelect: (cell: GridCell) => void;
};

export const cellId = (endTs: number, strikeE8: bigint) => `${endTs}:${strikeE8}`;

/**
 * The board.
 *
 * Columns are five-minute windows, rows are strikes, and the BTC price is drawn
 * straight across it — because the claim the product makes is that a price chart
 * *is* a grid of markets, and the fastest way to make that true is to show the
 * price passing through the cells it settles.
 *
 * Two columns of already-settled windows stay on the left. They are the proof:
 * a judge can watch a cell that was 0.63 an hour ago sitting there marked YES.
 */
export function Grid({
  columns,
  strikes,
  cells,
  spotE8,
  candles,
  now,
  selectedId,
  onSelect,
}: Props) {
  const { t } = useI18n();
  const boardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = boardRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const liveIndex = columns.findIndex((endTs) => endTs > now);

  // Rows share whatever height the board has. A ladder of seven leaves a wall of
  // empty terminal otherwise, and a ladder of twenty needs to scroll.
  const rowHeight =
    strikes.length === 0 ? MIN_ROW_HEIGHT : Math.max(MIN_ROW_HEIGHT, Math.floor(size.height / strikes.length));

  /** Price -> y pixel, interpolating between the two strikes that bracket it. */
  const priceToY = useMemo(() => {
    if (strikes.length === 0) return () => null;
    const values = strikes.map((s) => e8ToUsd(s));

    return (price: number): number | null => {
      const top = values[0]!;
      const bottom = values[values.length - 1]!;
      // Outside the ladder the line would be a lie about which cells it crosses.
      if (price > top || price < bottom) return null;

      for (let i = 0; i < values.length - 1; i++) {
        const upper = values[i]!;
        const lower = values[i + 1]!;
        if (price <= upper && price >= lower) {
          const fraction = upper === lower ? 0 : (upper - price) / (upper - lower);
          return (i + 0.5 + fraction) * rowHeight;
        }
      }
      return null;
    };
  }, [strikes, rowHeight]);

  // The overlay is inset past the strike axis, so every x is measured against
  // the plot area rather than the whole board.
  const plotWidth = Math.max(size.width - AXIS_WIDTH, 0);

  const gridStart = columns.length > 0 ? columns[0]! - WINDOW_SECONDS : 0;
  const gridSpan = columns.length * WINDOW_SECONDS;
  const timeToX = (unixSeconds: number) => ((unixSeconds - gridStart) / gridSpan) * plotWidth;

  /**
   * The realised path, drawn over the columns it actually happened in.
   *
   * Returned as segments rather than one polyline: when the price leaves the
   * strike ladder there is no honest y for it, and joining the points either
   * side of the gap would draw a line through cells the price never visited.
   */
  const priceSegments = useMemo(() => {
    if (plotWidth === 0 || candles.length === 0 || columns.length === 0) return [];

    const segments: string[][] = [];
    let current: string[] = [];

    for (const candle of candles) {
      const offset = candle.time - gridStart;
      const y = offset < 0 || offset > gridSpan ? null : priceToY(candle.close);
      if (y === null) {
        if (current.length > 1) segments.push(current);
        current = [];
        continue;
      }
      current.push(`${timeToX(candle.time).toFixed(1)},${y.toFixed(1)}`);
    }
    if (current.length > 1) segments.push(current);

    return segments.map((points) => points.join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, columns, priceToY, plotWidth]);

  const spotY = spotE8 === null ? null : priceToY(e8ToUsd(spotE8));
  // The marker belongs at *now*, not at the start of the live column.
  const spotX = plotWidth > 0 ? timeToX(now) : null;

  if (columns.length === 0 || strikes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[12px] text-[var(--color-ink-faint)]">
        {t("grid.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Column headers: the clock, which is the other half of every cell. */}
      <div
        className="grid border-b hairline"
        style={{ gridTemplateColumns: `${AXIS_WIDTH}px repeat(${columns.length}, minmax(78px, 1fr))` }}
      >
        <div className="label px-2 py-1.5">{t("grid.strike")}</div>
        {columns.map((endTs, index) => {
          const remaining = endTs - now;
          const isLive = index === liveIndex;
          const isPast = remaining <= 0;
          return (
            <div
              key={endTs}
              className={`px-2 py-1.5 text-center ${isLive ? "bg-[var(--color-raised)]" : ""}`}
            >
              <div className="num text-[11px] text-[var(--color-ink-dim)]">
                {new Date(endTs * 1000).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
              <div
                className="num text-[10px]"
                style={{
                  color: isPast
                    ? "var(--color-ink-faint)"
                    : remaining < 60
                      ? "var(--color-live)"
                      : "var(--color-ink-faint)",
                }}
              >
                {isPast ? t("grid.closed") : formatClock(remaining)}
              </div>
            </div>
          );
        })}
      </div>

      <div ref={boardRef} className="relative flex-1 overflow-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: `${AXIS_WIDTH}px repeat(${columns.length}, minmax(78px, 1fr))` }}
        >
          {strikes.map((strikeE8) => (
            <StrikeRow
              key={strikeE8.toString()}
              strikeE8={strikeE8}
              columns={columns}
              cells={cells}
              spotE8={spotE8}
              rowHeight={rowHeight}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>

        {/* The price, over the board. Absolute so it never disturbs the grid. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ left: AXIS_WIDTH }}
          aria-hidden
        >
          <svg width="100%" height="100%" className="overflow-visible">
            {priceSegments.map((points, index) => (
              <polyline
                key={index}
                points={points}
                fill="none"
                stroke="var(--color-ink)"
                strokeWidth={1.25}
                strokeLinejoin="round"
                opacity={0.75}
              />
            ))}
            {spotY !== null && (
              <>
                <line
                  x1={0}
                  x2="100%"
                  y1={spotY}
                  y2={spotY}
                  stroke="var(--color-ink)"
                  strokeWidth={0.75}
                  strokeDasharray="3 4"
                  opacity={0.4}
                />
                {spotX !== null && <circle cx={spotX} cy={spotY} r={3} fill="var(--color-ink)" />}
                {/* The price, pinned to its own line. Every strike on the board
                    is read against this number, so it should never be a
                    glance away in the header. */}
                <g transform={`translate(${Math.max(plotWidth - 62, 0)}, ${spotY - 8})`}>
                  <rect width={60} height={16} rx={2} fill="var(--color-ink)" />
                  <text
                    x={30}
                    y={11}
                    textAnchor="middle"
                    fontSize={10}
                    fontFamily="var(--font-mono)"
                    fill="var(--color-void)"
                  >
                    {spotE8 === null
                      ? ""
                      : e8ToUsd(spotE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </text>
                </g>
              </>
            )}
          </svg>
        </div>
      </div>

      <p className="border-t hairline px-3 py-1.5 text-[10px] text-[var(--color-ink-faint)]">
        {t("grid.legend")}
      </p>
    </div>
  );
}

function StrikeRow({
  strikeE8,
  columns,
  cells,
  spotE8,
  rowHeight,
  selectedId,
  onSelect,
}: {
  strikeE8: bigint;
  columns: number[];
  cells: Map<string, GridCell>;
  spotE8: bigint | null;
  rowHeight: number;
  selectedId: string | null;
  onSelect: (cell: GridCell) => void;
}) {
  const { t } = useI18n();

  // The row the spot is sitting in is the "up/down" cell — the same product,
  // just the strike that happens to be at the money.
  const atMoney =
    spotE8 !== null &&
    (() => {
      const diff = Number(strikeE8 - spotE8) / 1e8;
      return Math.abs(diff) < e8ToUsd(spotE8) * 0.0003;
    })();

  return (
    <>
      <div
        className={`flex items-center justify-end border-b border-r hairline px-2 ${
          atMoney ? "bg-[var(--color-raised)]" : ""
        }`}
        style={{ height: rowHeight }}
      >
        <span className="num text-[11px] text-[var(--color-ink-dim)]">
          {e8ToUsd(strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </span>
      </div>

      {columns.map((endTs) => {
        const cell = cells.get(cellId(endTs, strikeE8));
        return (
          <CellTile
            key={`${endTs}:${strikeE8}`}
            cell={cell}
            selected={cell ? cellId(endTs, strikeE8) === selectedId : false}
            rowHeight={rowHeight}
            onSelect={onSelect}
          />
        );
      })}
    </>
  );
}

function CellTile({
  cell,
  selected,
  rowHeight,
  onSelect,
}: {
  cell: GridCell | undefined;
  selected: boolean;
  rowHeight: number;
  onSelect: (cell: GridCell) => void;
}) {
  const { t } = useI18n();

  if (!cell) {
    return (
      <div
        className="border-b border-r hairline bg-[color-mix(in_oklab,var(--color-void)_60%,transparent)]"
        style={{ height: rowHeight }}
      />
    );
  }

  const probability = cell.impliedProbability;
  const settled = cell.outcome !== Outcome.Unresolved;

  /**
   * Fill carries the belief, and the hue carries which side of the money the
   * cell is on: green once the book thinks YES is more likely than not, red
   * below. Intensity is how sure it is, so a 0.52 and a 0.94 are never the same
   * shade. Everything else on the tile is text.
   */
  const p = probability === null ? null : Math.min(Math.max(probability, 0), 1);
  const inTheMoney = p !== null && p >= 0.5;
  const conviction = p === null ? 0 : Math.abs(p - 0.5) * 2; // 0 at a coin flip, 1 at certainty
  const background = settled
    ? cell.outcome === Outcome.Yes
      ? "color-mix(in oklab, var(--color-yes) 22%, transparent)"
      : cell.outcome === Outcome.No
        ? "color-mix(in oklab, var(--color-no) 16%, transparent)"
        : "var(--color-raised)"
    : p === null
      ? "transparent"
      : `color-mix(in oklab, var(--color-${inTheMoney ? "yes" : "no"}) ${(4 + conviction * 20).toFixed(1)}%, transparent)`;

  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      data-selected={selected}
      className="cell flex flex-col items-center justify-center gap-0.5 border-b border-r hairline text-center"
      style={{ height: rowHeight, background }}
      title={`${e8ToUsd(cell.strikeE8).toLocaleString()} · ${new Date(cell.endTs * 1000).toLocaleTimeString()}`}
    >
      {settled ? (
        <span
          className="num text-[12px] font-semibold"
          style={{
            color:
              cell.outcome === Outcome.Yes
                ? "var(--color-yes)"
                : cell.outcome === Outcome.No
                  ? "var(--color-no)"
                  : "var(--color-ink-faint)",
          }}
        >
          {cell.outcome === Outcome.Yes ? "YES" : cell.outcome === Outcome.No ? "NO" : "VOID"}
        </span>
      ) : p === null ? (
        <span className="text-[10px] text-[var(--color-ink-faint)]">{t("grid.noBook")}</span>
      ) : (
        <>
          {/* The payoff, not the probability. A trader decides on "1.9x", and
              the percentage is the same fact stated in a way that takes an extra
              beat to convert. Both are here; the useful one is bigger. */}
          <span
            className="num text-[13px] leading-none"
            style={{ color: inTheMoney ? "var(--color-yes)" : "var(--color-no)" }}
          >
            {p >= 0.995 ? "1.0" : (1 / Math.max(p, 0.005)).toFixed(p < 0.1 ? 0 : 1)}
            <span className="text-[9px] opacity-70">x</span>
          </span>
          {/* Probability, market width, and how many makers stand behind it —
              which is what decides whether the number above is a price or a
              decoration. */}
          <span className="num text-[9px] leading-none text-[var(--color-ink-faint)]">
            {(p * 100).toFixed(0)}%
            {cell.spread !== null && ` · ${(cell.spread * 200).toFixed(1)}w`}
            {cell.makers > 0 && ` · ${cell.makers}`}
          </span>
        </>
      )}
    </button>
  );
}

/** Best available read of the YES probability, from whichever leg has a book. */
export function impliedProbability(
  yesBid: bigint | null,
  yesAsk: bigint | null,
  noBid: bigint | null,
  noAsk: bigint | null,
  yesLast: bigint | null,
): number | null {
  if (yesBid !== null && yesAsk !== null) return (tickToProb(yesBid) + tickToProb(yesAsk)) / 2;
  // A NO book is a YES book read backwards: 1 - mid(NO).
  if (noBid !== null && noAsk !== null) return 1 - (tickToProb(noBid) + tickToProb(noAsk)) / 2;
  if (yesLast !== null) return tickToProb(yesLast);
  if (yesAsk !== null) return tickToProb(yesAsk);
  if (yesBid !== null) return tickToProb(yesBid);
  return null;
}
