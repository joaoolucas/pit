"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { Candle } from "@/lib/usePrice";
import { e8ToUsd, formatClock, Outcome, tickToProb, WINDOW_SECONDS } from "@cell/core";
import type { GridCell } from "./types";

const ROW_HEIGHT = 46;

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const liveIndex = columns.findIndex((endTs) => endTs > now);

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
          return (i + 0.5 + fraction) * ROW_HEIGHT;
        }
      }
      return null;
    };
  }, [strikes]);

  const columnWidth = columns.length > 0 ? size.width / columns.length : 0;

  /** The realised path, drawn over the columns it actually happened in. */
  const pricePath = useMemo(() => {
    if (columnWidth === 0 || candles.length === 0 || columns.length === 0) return "";
    const firstEnd = columns[0]!;
    const start = firstEnd - WINDOW_SECONDS;
    const span = columns.length * WINDOW_SECONDS;

    const points: string[] = [];
    for (const candle of candles) {
      const offset = candle.time - start;
      if (offset < 0 || offset > span) continue;
      const y = priceToY(candle.close);
      if (y === null) continue;
      points.push(`${((offset / span) * size.width).toFixed(1)},${y.toFixed(1)}`);
    }
    return points.length > 1 ? points.join(" ") : "";
  }, [candles, columns, columnWidth, priceToY, size.width]);

  const spotY = spotE8 === null ? null : priceToY(e8ToUsd(spotE8));
  const spotX = liveIndex >= 0 && columnWidth > 0 ? liveIndex * columnWidth : null;

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
        style={{ gridTemplateColumns: `72px repeat(${columns.length}, minmax(78px, 1fr))` }}
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
                {isPast ? t("grid.settled") : formatClock(remaining)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="relative flex-1 overflow-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: `72px repeat(${columns.length}, minmax(78px, 1fr))` }}
        >
          {strikes.map((strikeE8) => (
            <StrikeRow
              key={strikeE8.toString()}
              strikeE8={strikeE8}
              columns={columns}
              cells={cells}
              spotE8={spotE8}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>

        {/* The price, over the board. Absolute so it never disturbs the grid. */}
        <div
          ref={bodyRef}
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ left: 72 }}
          aria-hidden
        >
          <svg width="100%" height="100%" className="overflow-visible">
            {pricePath && (
              <polyline
                points={pricePath}
                fill="none"
                stroke="var(--color-ink)"
                strokeWidth={1.25}
                strokeLinejoin="round"
                opacity={0.75}
              />
            )}
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
  selectedId,
  onSelect,
}: {
  strikeE8: bigint;
  columns: number[];
  cells: Map<string, GridCell>;
  spotE8: bigint | null;
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
        style={{ height: ROW_HEIGHT }}
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
  onSelect,
}: {
  cell: GridCell | undefined;
  selected: boolean;
  onSelect: (cell: GridCell) => void;
}) {
  const { t } = useI18n();

  if (!cell) {
    return (
      <div
        className="border-b border-r hairline bg-[color-mix(in_oklab,var(--color-void)_60%,transparent)]"
        style={{ height: ROW_HEIGHT }}
      />
    );
  }

  const probability = cell.impliedProbability;
  const settled = cell.outcome !== Outcome.Unresolved;

  // Fill carries the belief. Everything else on the tile is text, so a trader can
  // read the board at a glance and the detail only when they look.
  const intensity = probability === null ? 0 : Math.min(Math.max(probability, 0), 1);
  const background = settled
    ? cell.outcome === Outcome.Yes
      ? "color-mix(in oklab, var(--color-yes) 20%, transparent)"
      : cell.outcome === Outcome.No
        ? "color-mix(in oklab, var(--color-no) 14%, transparent)"
        : "var(--color-raised)"
    : `color-mix(in oklab, var(--color-yes) ${(intensity * 22).toFixed(1)}%, transparent)`;

  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      data-selected={selected}
      className="cell flex flex-col items-center justify-center gap-0.5 border-b border-r hairline text-center"
      style={{ height: ROW_HEIGHT, background }}
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
      ) : probability === null ? (
        <span className="text-[10px] text-[var(--color-ink-faint)]">{t("grid.noBook")}</span>
      ) : (
        <>
          <span className="num text-[13px] leading-none text-[var(--color-ink)]">
            {(probability * 100).toFixed(0)}
            <span className="text-[9px] text-[var(--color-ink-faint)]">%</span>
          </span>
          <span className="num text-[9px] leading-none text-[var(--color-ink-faint)]">
            {cell.spread === null ? "—" : `±${(cell.spread * 100).toFixed(1)}`}
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
