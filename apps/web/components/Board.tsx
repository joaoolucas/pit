"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useClock, useI18n } from "@/lib/i18n";
import type { Candle } from "@/lib/usePrice";
import {
  e8ToUsd,
  formatCents,
  formatClock,
  formatMultiple,
  locateOnLadder,
  Outcome,
  sizeToContracts,
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

/** Where the pointer is, and what is under it. */
type Aim = {
  row: number;
  column: number;
  /** Null on a slot the roller has not opened yet — the crosshair still draws. */
  cell: BoardCell | null;
  rect: DOMRect;
};

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
  /**
   * What the pointer is on.
   *
   * A chain is wide: the strike lives on the far right of the row and the expiry
   * at the top of the column, so a tile in the middle of the board is a market
   * you cannot name without tracing two lines with your finger. Holding the aim
   * lets the board draw those lines for you — and lets the card say the rest.
   */
  const [aim, setAim] = useState<Aim | null>(null);

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

  // The board scrolls under the pointer; a stale rectangle would leave the card
  // floating over the wrong tile.
  const clearAim = () => setAim(null);

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
              aimed={aim?.column === index}
            />
          ))}
          <div className="flex items-end justify-end px-2 pb-2">
            <span className="label">{t("board.strike")}</span>
          </div>
        </div>
      </div>

      {/* Body: the trace on the left, the chain on the right, sharing rows. */}
      {/* The body scrolls under the heads. Without the mask a row is sliced
          flat against the clock row and reads as a rendering fault rather than
          as more board. */}
      <div
        ref={bodyRef}
        onScroll={clearAim}
        onMouseLeave={clearAim}
        className="board-scroll flex min-h-0 flex-1 overflow-y-auto px-1.5 pb-1"
      >
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
                row={row}
                columns={columns}
                cells={cells}
                maxDepth={maxDepth}
                rowHeight={rowHeight}
                now={now}
                atm={atm}
                spotE8={atm ? spotE8 : null}
                selectedId={selectedId}
                onSelect={onSelect}
                aim={aim}
                onAim={setAim}
              />
            );
          })}
        </div>
      </div>

      <Legend />

      {aim?.cell && <CellCard cell={aim.cell} rect={aim.rect} now={now} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ColumnHead({
  endTs,
  now,
  live,
  aimed,
}: {
  endTs: number;
  now: number;
  live: boolean;
  aimed: boolean;
}) {
  const { t } = useI18n();
  const clock = useClock();
  const remaining = endTs - now;
  const closed = remaining <= 0;
  const urgent = !closed && remaining < 60;

  // How far through its five minutes this window is. Only drawn on the live one,
  // where it is the difference between "plenty of time" and "decide now".
  const elapsed = live ? Math.min(Math.max(1 - remaining / WINDOW_SECONDS, 0), 1) : 0;

  return (
    <div
      className={`relative flex flex-col items-center gap-0.5 rounded-[18px] px-1 pb-2 pt-1.5 transition-colors ${
        live ? "bg-[color-mix(in_oklab,var(--color-live)_14%,transparent)]" : ""
      } ${aimed ? "aimed-head" : ""}`}
    >
      <span
        className="data text-[11px]"
        style={{ color: aimed ? "var(--color-foam)" : "var(--color-foam-dim)" }}
      >
        {clock(endTs)}
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
  row,
  columns,
  cells,
  maxDepth,
  rowHeight,
  now,
  atm,
  spotE8,
  selectedId,
  onSelect,
  aim,
  onAim,
}: {
  strikeE8: bigint;
  row: number;
  columns: number[];
  cells: Map<string, BoardCell>;
  maxDepth: bigint;
  rowHeight: number;
  now: number;
  atm: boolean;
  spotE8: bigint | null;
  selectedId: string | null;
  onSelect: (cell: BoardCell) => void;
  aim: Aim | null;
  onAim: (aim: Aim | null) => void;
}) {
  const { t } = useI18n();
  const aimedRow = aim?.row === row;

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
            row={row}
            column={index}
            selected={key === selectedId}
            onSelect={onSelect}
            aimed={aimedRow || aim?.column === index}
            onAim={onAim}
          />
        );
      })}

      {/* The strike axis. The spot badge rides the at-the-money row, so the
          number every other strike is judged against is never a glance away. */}
      <div
        className={`relative flex items-center justify-end gap-2 rounded-[18px] px-2 transition-colors ${
          atm ? "atm" : ""
        } ${aimedRow ? "aimed-head" : ""}`}
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
        <span
          className="readout text-[13px]"
          style={{ color: aimedRow ? "var(--color-foam)" : "var(--color-foam-dim)" }}
        >
          {e8ToUsd(strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </span>
      </div>
    </>
  );
}

/**
 * The pigments, as numbers.
 *
 * Mirrors --color-yes / --color-no / --color-deep / --color-foam in globals.css.
 * The tile paints itself with color-mix on those tokens; this copy exists only
 * so the label can work out what colour it is about to sit on.
 */
const PIGMENT = { yes: [125, 255, 179], no: [255, 143, 171] } as const;
const GROUND = [26, 18, 36] as const;
const FOAM = [255, 244, 232] as const;

/** How much white the pigment is cut with, and how opaque it goes on. */
const whiteCut = (ink: TileInk) => 1 - (0.55 + ink.conviction * 0.45);
const alphaOf = (ink: TileInk) => 0.42 + ink.presence * 0.48;

/** Turns the two-channel ink into a CSS colour. Hue by side, alpha by depth. */
function fillFor(ink: TileInk): string {
  if (ink.side === "none" || ink.presence === 0) return "transparent";
  const hue = `color-mix(in oklab, var(--color-${ink.side}) ${(
    55 +
    ink.conviction * 45
  ).toFixed(0)}%, white)`;
  const alpha = (alphaOf(ink) * 100).toFixed(1);
  return `color-mix(in oklab, ${hue} ${alpha}%, transparent)`;
}

const luminance = ([r, g, b]: readonly number[]): number => {
  const channel = (v: number) => {
    const c = (v ?? 0) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};

const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/**
 * What colour the multiple is printed in.
 *
 * The pigments are pastels, so a deep book paints a *light* balloon — and the
 * side colour that reads beautifully on a hollow tile disappears into it. The
 * number is the single most important thing on this board, so it does not get to
 * be a casualty of the depth channel: on a painted balloon the label is whichever
 * of the ground or the foam actually reads against the paint, and the balloon's
 * own hue goes on saying which side it is. Only a hollow tile, where there is no
 * paint to say it, keeps the side colour in the type.
 */
function labelFor(ink: TileInk): { strong: string; quiet: string } {
  const side = ink.side === "no" ? "no" : "yes";

  if (ink.side === "none" || ink.presence === 0) {
    return { strong: `var(--color-${side})`, quiet: "var(--color-foam-dim)" };
  }

  const white = whiteCut(ink);
  const alpha = alphaOf(ink);
  const composite = PIGMENT[side].map((channel, i) => {
    const pigment = channel * (1 - white) + 255 * white;
    return pigment * alpha + GROUND[i]! * (1 - alpha);
  });

  return contrast(composite, GROUND) >= contrast(composite, FOAM)
    ? { strong: "var(--color-deep)", quiet: "color-mix(in oklab, var(--color-deep) 68%, transparent)" }
    : { strong: "var(--color-foam)", quiet: "var(--color-foam-dim)" };
}

function Tile({
  cell,
  maxDepth,
  rowHeight,
  closed,
  atm,
  row,
  column,
  selected,
  onSelect,
  aimed,
  onAim,
}: {
  cell: BoardCell | undefined;
  maxDepth: bigint;
  rowHeight: number;
  closed: boolean;
  atm: boolean;
  row: number;
  column: number;
  selected: boolean;
  onSelect: (cell: BoardCell) => void;
  aimed: boolean;
  onAim: (aim: Aim | null) => void;
}) {
  const { t } = useI18n();

  // Pointer and keyboard both take aim, so tabbing the board reads the same as
  // moving over it.
  const take = (event: { currentTarget: HTMLElement }) =>
    onAim({ row, column, cell: cell ?? null, rect: event.currentTarget.getBoundingClientRect() });

  // No market at this (expiry, strike) yet — the roller has not opened it. An
  // invisible div here made whole columns read as a broken board, so the slot
  // gets a faint outline: present, empty, and visibly not a tile you can click.
  if (!cell) {
    return (
      <div
        aria-hidden
        onMouseEnter={take}
        className={`slot rounded-[22px] ${atm ? "atm" : ""} ${aimed ? "aimed" : ""}`}
        style={{ height: rowHeight }}
      />
    );
  }

  const settled = cell.outcome !== Outcome.Unresolved;
  const cents = cell.cents;
  const ink = tileInk(settled ? null : cents, cell.depth, maxDepth);
  const label = labelFor(ink);

  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      data-selected={selected}
      data-empty={ink.presence === 0}
      onMouseEnter={take}
      onFocus={take}
      onBlur={() => onAim(null)}
      className={`tile sweep flex flex-col items-center justify-center gap-1 ${
        atm ? "atm" : ""
      } ${aimed ? "aimed" : ""}`}
      style={
        {
          height: rowHeight,
          "--fill": fillFor(ink),
          animationDelay: `${Math.min(column * 45, 400)}ms`,
        } as React.CSSProperties
      }
      aria-label={cell.title}
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
        // "–" made an unquoted market look like a rendering gap. It is a market
        // with nobody on either side, and the legend already promises that a
        // hollow tile means exactly that — so it may as well say it.
        <span className="label text-[9px] leading-none">{t("board.noDepth")}</span>
      ) : (
        <>
          <span
            className="readout text-[22px] leading-none sm:text-[24px]"
            style={{ color: label.strong }}
          >
            {formatMultiple(cents)}
          </span>
          {/* What it costs. How deep it is, the paint already said. */}
          <span className="data text-[11px] leading-none" style={{ color: label.quiet }}>
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
  const clock = useClock();
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
              {/* Labelled at the top, under the head row: the bottom of this
                  SVG is wherever the ladder happens to end, which put the time
                  axis in the middle of the scroll and straight through the
                  price line. */}
              <text
                x={toX(ts) + 4}
                y={12}
                fontSize={9}
                fill="var(--color-foam-faint)"
                fontFamily="var(--font-data)"
              >
                {clock(ts)}
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

/**
 * What the pointer is on, said next to the pointer.
 *
 * The rail on the right holds the book, the tape and the ticket, and it is 360
 * pixels away from the tile you are looking at — on a market with four minutes
 * left, that is a trip. This is the fast read: what the claim is, what it costs
 * on each side, how wide it is and who is behind it, printed against the tile
 * itself. Clicking still opens the rail; this only saves you from having to.
 *
 * Fixed rather than absolute, because the board scrolls and an absolutely
 * placed card would be clipped by the scroll container it lives in.
 */
function CellCard({ cell, rect, now }: { cell: BoardCell; rect: DOMRect; now: number }) {
  const { t } = useI18n();
  const clock = useClock();

  const remaining = cell.endTs - now;
  const settled = cell.outcome !== Outcome.Unresolved;
  const yes = cell.cents;
  const no = yes === null ? null : 100 - yes;
  const contracts = Math.round(sizeToContracts(cell.depth));

  const WIDTH = 216;
  const GAP = 10;
  // Flip to the left of the tile when there is no room to the right of it.
  const room = typeof window === "undefined" ? Infinity : window.innerWidth - rect.right;
  const left = room > WIDTH + GAP ? rect.right + GAP : Math.max(GAP, rect.left - WIDTH - GAP);
  const top =
    typeof window === "undefined"
      ? rect.top
      : Math.min(Math.max(GAP, rect.top), window.innerHeight - 168);

  return (
    <div
      aria-hidden
      className="panel pointer-events-none fixed z-40 rounded-[20px] px-3 py-2.5 shadow-[0_10px_0_rgba(20,8,28,0.32)]"
      style={{ left, top, width: WIDTH }}
    >
      <p className="text-[12px] font-extrabold leading-snug text-[var(--color-foam)]">
        {t("cell.claim", {
          strike: `${e8ToUsd(cell.strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
        })}
      </p>
      <p className="data mt-0.5 text-[10px] text-[var(--color-foam-faint)]">
        {clock(cell.endTs)} ·{" "}
        {settled || remaining <= 0
          ? t("board.cardClosed")
          : t("board.cardLeft", { clock: formatClock(remaining) })}
      </p>

      {yes === null ? (
        <p className="label mt-2">{t("board.noDepth")}</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <Leg side="yes" cents={yes} />
            <Leg side="no" cents={no!} />
          </div>

          <dl className="mt-2 flex flex-col gap-0.5 border-t rule pt-1.5">
            {cell.widthCents !== null && (
              <Fact label={t("board.cardSpread")} value={`${cell.widthCents}¢`} />
            )}
            <Fact label={t("board.cardDepth")} value={contracts.toLocaleString()} />
            {cell.makers > 0 && (
              <Fact label={t("board.cardMakers")} value={String(cell.makers)} />
            )}
          </dl>
        </>
      )}
    </div>
  );
}

function Leg({ side, cents }: { side: "yes" | "no"; cents: number }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-col gap-0.5">
      <span className="label" style={{ color: `var(--color-${side})` }}>
        {t(`ticket.${side}` as const)}
      </span>
      <span className="readout text-[20px] leading-none" style={{ color: `var(--color-${side})` }}>
        {formatCents(cents)}
      </span>
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="label">{label}</dt>
      <dd className="data text-[10.5px] text-[var(--color-foam-dim)]">{value}</dd>
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

      {/* The board is a grid of buttons and nothing about a grid says so. */}
      <span className="label ml-auto text-[var(--color-foam-dim)]">
        {t("board.legendHint")}
      </span>
    </div>
  );
}
