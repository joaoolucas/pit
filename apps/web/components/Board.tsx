"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import type { Candle } from "@/lib/usePrice";
import {
  e8ToUsd,
  formatCents,
  formatClock,
  formatMultiple,
  locateOnLadder,
  Outcome,
  tileInk,
  WINDOW_SECONDS,
  type TileInk,
} from "@pit/core";
import type { BoardCell } from "./types";

/** Rows never get thinner than this — the multiple is the headline, so it needs room. */
const MIN_ROW_HEIGHT = 72;
/** The strike axis, on the right, where a chart puts its price scale. */
const AXIS_WIDTH = 92;
/** Minutes of realised price kept to the left of now. */
const TRACE_MINUTES = 30;
/**
 * How much of the width the realised price gets.
 *
 * The chain is the product, so it takes the larger share; the trace only has to
 * be wide enough to read the shape of the last half hour. Both the head row and
 * the body use this constant, which is the only thing keeping their columns
 * lined up.
 */
const TRACE_WIDTH = "28%";
/** Gap between balloons. Shared by the head row and the body so they line up. */
const BOARD_GAP = 6;

export const cellId = (endTs: number, strikeE8: bigint) => `${endTs}:${strikeE8}`;

type Props = {
  /** Expiries, ascending. The first one that has not closed is the live column. */
  columns: number[];
  /** Strikes, highest first. */
  strikes: bigint[];
  cells: Map<string, BoardCell>;
  spotE8: bigint | null;
  candles: Candle[];
  now: number;
  selectedId: string | null;
  onSelect: (cell: BoardCell) => void;
};

/**
 * The board.
 *
 * An option chain: strikes down the right-hand axis, expiries across the top,
 * and the realised price running into it from the left. Time is continuous
 * across the whole surface — the left half is where the price has been, the
 * right half is what it can be bought and sold against — so the claim that a
 * price chart *is* a board of markets is not a metaphor on this screen, it is
 * the layout.
 *
 * Each tile carries two facts in two channels: the number says what the book
 * charges, and the paint says how much is resting behind it. Cells nobody quotes
 * stay hollow. See `tileInk` in @pit/core.
 */
export function Board({
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
  const [bodyHeight, setBodyHeight] = useState(0);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBodyHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rowHeight =
    strikes.length === 0
      ? MIN_ROW_HEIGHT
      : Math.max(MIN_ROW_HEIGHT, Math.floor(bodyHeight / strikes.length));

  const liveIndex = columns.findIndex((endTs) => endTs > now);

  /** The deepest book on the board. Every tile's paint is relative to it. */
  const maxDepth = useMemo(() => {
    let max = 0n;
    for (const cell of cells.values()) if (cell.depth > max) max = cell.depth;
    return max;
  }, [cells]);

  const spotAt = spotE8 === null ? null : locateOnLadder(strikes, spotE8);

  if (columns.length === 0 || strikes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <BalloonCluster />
        <p className="readout text-[22px] text-[var(--color-foam)]">{t("board.empty")}</p>
        <p className="max-w-xs text-[13px] leading-relaxed text-[var(--color-foam-faint)]">
          {t("board.emptyHint")}
        </p>
      </div>
    );
  }

  const chainTemplate = `repeat(${columns.length}, minmax(78px, 1fr)) ${AXIS_WIDTH}px`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Heads: the clock, which is the other half of every market here. */}
      <div className="flex shrink-0 px-1.5 pt-2">
        <div
          className="flex min-w-0 shrink-0 items-end justify-between px-3 pb-2"
          style={{ width: TRACE_WIDTH }}
        >
          <span className="label">{t("board.realised", { minutes: TRACE_MINUTES })}</span>
          <span className="label hidden sm:inline">{t("board.now")}</span>
        </div>
        <div
          className="grid min-w-0 flex-1"
          style={{ gridTemplateColumns: chainTemplate, gap: BOARD_GAP }}
        >
          {columns.map((endTs, index) => (
            <ColumnHead
              key={endTs}
              endTs={endTs}
              now={now}
              live={index === liveIndex}
              index={index}
            />
          ))}
          <div className="flex items-end justify-end px-2 pb-2">
            <span className="label">{t("board.strike")}</span>
          </div>
        </div>
      </div>

      {/* Body: the trace on the left, the chain on the right, sharing rows. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        <Trace
          candles={candles}
          strikes={strikes}
          rowHeight={rowHeight}
          now={now}
          spotAt={spotAt}
        />

        <div
          className="grid min-w-0 flex-1 content-start"
          style={{ gridTemplateColumns: chainTemplate, gap: BOARD_GAP, rowGap: BOARD_GAP }}
        >
          {strikes.map((strikeE8, row) => {
            const atm = spotAt?.on === "ladder" && Math.floor(spotAt.offset) === row;
            return (
              <StrikeRow
                key={strikeE8.toString()}
                strikeE8={strikeE8}
                columns={columns}
                cells={cells}
                maxDepth={maxDepth}
                rowHeight={rowHeight}
                now={now}
                atm={atm}
                spotE8={atm ? spotE8 : null}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>

      <Legend />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ColumnHead({
  endTs,
  now,
  live,
  index,
}: {
  endTs: number;
  now: number;
  live: boolean;
  index: number;
}) {
  const { t } = useI18n();
  const remaining = endTs - now;
  const closed = remaining <= 0;
  const urgent = !closed && remaining < 60;

  // How far through its five minutes this window is. Only drawn on the live one,
  // where it is the difference between "plenty of time" and "decide now".
  const elapsed = live ? Math.min(Math.max(1 - remaining / WINDOW_SECONDS, 0), 1) : 0;

  return (
    <div
      className={`relative flex flex-col items-center gap-0.5 rounded-[18px] px-1 pb-2 pt-1.5 ${
        live ? "bg-[color-mix(in_oklab,var(--color-live)_14%,transparent)]" : ""
      }`}
    >
      <span className="data text-[11px] text-[var(--color-foam-dim)]">
        {new Date(endTs * 1000).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span
        className="readout text-[13px] leading-none"
        style={{
          color: closed
            ? "var(--color-foam-faint)"
            : urgent
              ? "var(--color-live)"
              : "var(--color-foam)",
        }}
      >
        {closed ? t("board.closed") : formatClock(remaining)}
      </span>
      {live && (
        <span
          aria-hidden
          className="absolute bottom-1 left-2 right-2 h-[5px] overflow-hidden rounded-full bg-[var(--color-rule)]"
        >
          <span
            className="block h-full rounded-full bg-[var(--color-live)] transition-[width] duration-1000 ease-linear"
            style={{ width: `${(elapsed * 100).toFixed(1)}%` }}
          />
        </span>
      )}
    </div>
  );
}

function StrikeRow({
  strikeE8,
  columns,
  cells,
  maxDepth,
  rowHeight,
  now,
  atm,
  spotE8,
  selectedId,
  onSelect,
}: {
  strikeE8: bigint;
  columns: number[];
  cells: Map<string, BoardCell>;
  maxDepth: bigint;
  rowHeight: number;
  now: number;
  atm: boolean;
  spotE8: bigint | null;
  selectedId: string | null;
  onSelect: (cell: BoardCell) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      {columns.map((endTs, index) => {
        const key = cellId(endTs, strikeE8);
        return (
          <Tile
            key={key}
            cell={cells.get(key)}
            maxDepth={maxDepth}
            rowHeight={rowHeight}
            closed={endTs <= now}
            atm={atm}
            column={index}
            selected={key === selectedId}
            onSelect={onSelect}
          />
        );
      })}

      {/* The strike axis. The spot badge rides the at-the-money row, so the
          number every other strike is judged against is never a glance away. */}
      <div
        className={`relative flex items-center justify-end gap-2 rounded-[18px] px-2 ${
          atm ? "atm" : ""
        }`}
        style={{ height: rowHeight }}
      >
        {spotE8 !== null && (
          <span
            className="readout rounded-full bg-[var(--color-trace)] px-2 py-0.5 text-[11px] text-[var(--color-deep)] shadow-[0_3px_0_rgba(20,8,28,0.25)]"
            title={t("board.spot")}
          >
            {e8ToUsd(spotE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        )}
        <span className="readout text-[13px] text-[var(--color-foam-dim)]">
          {e8ToUsd(strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </span>
      </div>
    </>
  );
}

/** Turns the two-channel ink into a CSS colour. Hue by side, alpha by depth. */
function fillFor(ink: TileInk): string {
  if (ink.side === "none" || ink.presence === 0) return "transparent";
  const hue = `color-mix(in oklab, var(--color-${ink.side}) ${(
    55 +
    ink.conviction * 45
  ).toFixed(0)}%, white)`;
  const alpha = (42 + ink.presence * 48).toFixed(1);
  return `color-mix(in oklab, ${hue} ${alpha}%, transparent)`;
}

function Tile({
  cell,
  maxDepth,
  rowHeight,
  closed,
  atm,
  column,
  selected,
  onSelect,
}: {
  cell: BoardCell | undefined;
  maxDepth: bigint;
  rowHeight: number;
  closed: boolean;
  atm: boolean;
  column: number;
  selected: boolean;
  onSelect: (cell: BoardCell) => void;
}) {
  const { t } = useI18n();

  if (!cell) {
    return (
      <div
        className={`rounded-[22px] ${atm ? "atm" : ""}`}
        style={{ height: rowHeight }}
      />
    );
  }

  const settled = cell.outcome !== Outcome.Unresolved;
  const cents = cell.cents;
  const ink = tileInk(settled ? null : cents, cell.depth, maxDepth);

  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      data-selected={selected}
      data-empty={ink.presence === 0}
      className={`tile sweep flex flex-col items-center justify-center gap-1 ${
        atm ? "atm" : ""
      }`}
      style={
        {
          height: rowHeight,
          "--fill": fillFor(ink),
          animationDelay: `${Math.min(column * 45, 400)}ms`,
        } as React.CSSProperties
      }
      title={cell.title}
    >
      {settled ? (
        <Resolved outcome={cell.outcome} />
      ) : closed ? (
        // Closed, waiting on a price. Showing the last multiple here would
        // invite a click on a market that cannot be traded, and the word
        // repeated down a whole column is noise — a dot says it once per cell.
        <span
          aria-label={t("board.settling")}
          title={t("board.settling")}
          className="orb inline-block size-2.5 bg-[var(--color-live)]"
        />
      ) : cents === null ? (
        <span className="text-[13px] leading-none text-[var(--color-foam-faint)]">–</span>
      ) : (
        <>
          <span
            className="readout text-[22px] leading-none sm:text-[24px]"
            style={{ color: `var(--color-${ink.side === "no" ? "no" : "yes"})` }}
          >
            {formatMultiple(cents)}
          </span>
          {/* What it costs. How deep it is, the paint already said. */}
          <span className="data text-[11px] leading-none text-[var(--color-foam-dim)]">
            {formatCents(cents)}
          </span>
        </>
      )}
    </button>
  );
}

function Resolved({ outcome }: { outcome: Outcome }) {
  const { t } = useI18n();
  const [text, colour] =
    outcome === Outcome.Yes
      ? [t("board.yes"), "var(--color-yes)"]
      : outcome === Outcome.No
        ? [t("board.no"), "var(--color-no)"]
        : [t("board.void"), "var(--color-foam-faint)"];

  return (
    <span className="readout text-[16px] tracking-wide" style={{ color: colour }}>
      {text}
    </span>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Where the price has been.
 *
 * Drawn as a trace with a wake: the recent past at full strength, older minutes
 * fading, because on a five-minute market the last thirty seconds carry most of
 * the information. Rows line up with the chain's strikes, so the trace visibly
 * passes through the levels it is being traded against.
 */
function Trace({
  candles,
  strikes,
  rowHeight,
  now,
  spotAt,
}: {
  candles: Candle[];
  strikes: bigint[];
  rowHeight: number;
  now: number;
  spotAt: ReturnType<typeof locateOnLadder>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const height = strikes.length * rowHeight;
  const from = now - TRACE_MINUTES * 60;
  const toX = (unix: number) => ((unix - from) / (now - from)) * width;

  const priceToY = (priceUsd: number): number | null => {
    const at = locateOnLadder(strikes, BigInt(Math.round(priceUsd * 1e8)));
    return at?.on === "ladder" ? at.offset * rowHeight : null;
  };

  // Segments, not one polyline: joining across a gap would draw a line through
  // strikes the price never visited.
  const segments = useMemo(() => {
    if (width === 0 || candles.length === 0) return [];
    const out: string[][] = [];
    let run: string[] = [];

    for (const candle of candles) {
      const y = candle.time < from || candle.time > now ? null : priceToY(candle.close);
      if (y === null) {
        if (run.length > 1) out.push(run);
        run = [];
        continue;
      }
      run.push(`${toX(candle.time).toFixed(1)},${y.toFixed(1)}`);
    }
    if (run.length > 1) out.push(run);
    return out.map((points) => points.join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, width, rowHeight, strikes, now]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    const step = 10 * 60;
    for (let ts = Math.ceil(from / step) * step; ts <= now; ts += step) out.push(ts);
    return out;
  }, [from, now]);

  return (
    <div ref={ref} className="relative shrink-0" style={{ width: TRACE_WIDTH }}>
      <svg width="100%" height={height} className="block">
        <defs>
          {/* The wake: older price is fainter. */}
          <linearGradient id="wake" x1="0" x2="1">
            <stop offset="0%" stopColor="var(--color-trace)" stopOpacity="0.12" />
            <stop offset="65%" stopColor="var(--color-trace)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--color-trace)" stopOpacity="1" />
          </linearGradient>
        </defs>

        {/* Strike rows, continued into the past so the trace reads against them. */}
        {strikes.map((strike, row) => (
          <line
            key={strike.toString()}
            x1={0}
            x2="100%"
            y1={(row + 1) * rowHeight}
            y2={(row + 1) * rowHeight}
            stroke="var(--color-rule)"
            strokeWidth={1}
          />
        ))}

        {/* Ten-minute marks. */}
        {width > 0 &&
          ticks.map((ts) => (
            <g key={ts}>
              <line
                x1={toX(ts)}
                x2={toX(ts)}
                y1={0}
                y2={height}
                stroke="var(--color-rule)"
                strokeWidth={1}
                opacity={0.55}
              />
              <text
                x={toX(ts) + 4}
                y={height - 6}
                fontSize={9}
                fill="var(--color-foam-faint)"
                fontFamily="var(--font-data)"
              >
                {new Date(ts * 1000).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </text>
            </g>
          ))}

        {/* Spot, level across the past only: the price has not been to the
            future yet, and drawing it there would say otherwise. */}
        {spotAt?.on === "ladder" && (
          <line
            x1={0}
            x2="100%"
            y1={spotAt.offset * rowHeight}
            y2={spotAt.offset * rowHeight}
            stroke="var(--color-trace)"
            strokeWidth={1}
            strokeDasharray="2 5"
            opacity={0.45}
          />
        )}

        {segments.map((points, index) => (
          <polyline
            key={index}
            points={points}
            fill="none"
            stroke="url(#wake)"
            strokeWidth={2.4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Now. */}
        {spotAt?.on === "ladder" && width > 0 && (
          <circle cx={width - 1} cy={spotAt.offset * rowHeight} r={5} fill="var(--color-trace)" />
        )}
      </svg>
    </div>
  );
}

export function BalloonCluster() {
  return (
    <span aria-hidden className="mb-1 flex items-end gap-1.5">
      <span className="orb floaty size-7 bg-[var(--color-yes)]" style={{ animationDelay: "0s" }} />
      <span className="orb floaty size-10 bg-[var(--color-live)]" style={{ animationDelay: "0.4s" }} />
      <span className="orb floaty size-6 bg-[var(--color-no)]" style={{ animationDelay: "0.8s" }} />
    </span>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2">
      <span className="label">{t("board.legendPay")}</span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="orb inline-block h-3 w-7"
          style={{
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--color-yes) 70%, white) 0%, color-mix(in oklab, var(--color-no) 55%, white) 100%)",
          }}
        />
        <span className="label">{t("board.legendDepth")}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3 w-7 rounded-full border-2 rule" />
        <span className="label">{t("board.legendHollow")}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-[3px] w-7 rounded-full bg-[var(--color-trace)]" />
        <span className="label">{t("board.legendTrace")}</span>
      </span>
    </div>
  );
}
