"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { rollCommand } from "@/lib/config";
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
  tickToCents,
  tileInk,
  WINDOW_SECONDS,
  type TileInk,
} from "@pit/core";
import type { BoardCell } from "./types";

/** Rows never get thinner than this — the multiple is the headline, so it needs room. */
const MIN_ROW_HEIGHT = 72;
/** The strike axis, on the right, where a chart puts its price scale. */
const AXIS_WIDTH = 106;
/**
 * How many lanes of history sit to the left of the chain.
 *
 * The trace used to be a panel of its own: a fixed 28% of the width, ruled on a
 * ten-minute pitch, showing the last half hour ending at now. That made two
 * boards out of one. The lattices never met — the chain's columns are five
 * minutes wide and the trace's ticks were ten — and worse, the trace's last
 * minutes are the *same* minutes as the columns beside it, drawn a second time
 * at a different x. A join between two clocks that disagree can only be a wall.
 *
 * There is one lattice now. Every lane on this board, past or future, is one
 * five-minute window wide, and the trace is simply the six windows before the
 * first column opens. The price is drawn over that shared grid and carries on
 * into the live column, which is where the price actually is.
 */
const PAST_LANES = 6;
/** Minutes of realised price the past lanes cover. */
const TRACE_MINUTES = (PAST_LANES * WINDOW_SECONDS) / 60;
/**
 * No gap between cells.
 *
 * Six pixels was enough to stop a row being a row. The eye could no longer run
 * from a cell in the middle of the board out to its strike on the axis, or up to
 * its expiry — and the trace's strike lines, drawn at multiples of the row
 * height, drifted six pixels a row out of step with the chain they are supposed
 * to be level with. Cells share edges and a hairline tells them apart. The grid
 * is the instrument; the round corners belong to the chrome around it.
 */
const BOARD_GAP = 0;

/**
 * An element's measured size.
 *
 * The board and the trace both used a `useRef` with a `useLayoutEffect([])`
 * that read `ref.current` once, on whichever commit it happened to run on. When
 * the node was not attached on that commit the observer was never created, the
 * effect never ran again — its dependency list is empty — and the measurement
 * stayed at zero for the life of the component. Zero width means the trace
 * draws no price line, no time axis and no now-dot; zero height means every row
 * falls back to its minimum. A callback ref runs when the node actually arrives,
 * which is the only moment either of them cares about.
 */
function useMeasured<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const next = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    next.observe(node);
    observer.current = next;

    // Measured now as well as on change, so the first paint is not a blank one.
    const rect = node.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
  }, []);

  return { ref, width: size.width, height: size.height };
}

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
  const { ref: bodyRef, height: bodyHeight } = useMeasured<HTMLDivElement>();
  /**
   * What the pointer is on.
   *
   * A chain is wide: the strike lives on the far right of the row and the expiry
   * at the top of the column, so a tile in the middle of the board is a market
   * you cannot name without tracing two lines with your finger. Holding the aim
   * lets the board draw those lines for you — and lets the card say the rest.
   */
  const [aim, setAim] = useState<Aim | null>(null);

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
        <p className="max-w-sm text-[13px] leading-relaxed text-[var(--color-foam-faint)]">
          {t("board.emptyHint", { command: rollCommand })}
        </p>
      </div>
    );
  }

  const laneCount = PAST_LANES + columns.length;
  /** One template for the head and the body: equal lanes, then the strike axis. */
  const boardTemplate = `repeat(${laneCount}, minmax(78px, 1fr)) ${AXIS_WIDTH}px`;

  /**
   * The board's clock, as one linear scale.
   *
   * Lane 0 opens `PAST_LANES` windows before the first column and the last lane
   * closes on the last expiry, so an instant has exactly one x on this surface
   * whether it has happened yet or not. Everything drawn over the grid — the
   * price line, the now mark — reads its position off these two numbers.
   */
  const boardFrom = columns[0]! - WINDOW_SECONDS * (1 + PAST_LANES);
  const boardTo = columns[columns.length - 1]!;

  /** How much of the live window is already spent. */
  const liveElapsed =
    liveIndex === -1
      ? 0
      : Math.min(Math.max(1 - (columns[liveIndex]! - now) / WINDOW_SECONDS, 0), 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Heads: the clock, which is the other half of every market here. */}
      <div className="shrink-0 border-b rule">
        <div
          className="grid min-w-0"
          style={{ gridTemplateColumns: boardTemplate, gap: BOARD_GAP }}
        >
          {/* The past lanes answer to one heading. What each of them is called
              is written on the board itself, in line with the column heads. */}
          <div
            className="flex min-w-0 items-end px-3 pb-1.5 pt-2"
            style={{ gridColumn: `span ${PAST_LANES}` }}
          >
            <span className="label">{t("board.realised", { minutes: TRACE_MINUTES })}</span>
          </div>
          {columns.map((endTs, index) => (
            <ColumnHead
              key={endTs}
              endTs={endTs}
              now={now}
              live={index === liveIndex}
              aimed={aim?.column === index}
            />
          ))}
          {/* Naming the axis names every row on it. "Strike" is the right word
              and says nothing to anyone meeting a prediction market for the
              first time; this way the claim reads straight off the board —
              "BTC above" at the head, the level on the row. */}
          <div className="flex items-end justify-end border-l rule px-2 pb-1.5">
            <span className="label text-right leading-[1.25]">{t("board.strikeAxis")}</span>
          </div>
        </div>
      </div>

      {/* Body: the trace on the left, the chain on the right, sharing rows. */}
      <div
        ref={bodyRef}
        onScroll={clearAim}
        onMouseLeave={clearAim}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <div
          className="grid min-w-0 content-start"
          style={{ gridTemplateColumns: boardTemplate, gap: BOARD_GAP, rowGap: BOARD_GAP }}
        >
          {strikes.map((strikeE8, row) => {
            const atm = spotAt?.on === "ladder" && Math.floor(spotAt.offset) === row;
            return (
              <StrikeRow
                key={strikeE8.toString()}
                strikeE8={strikeE8}
                row={row}
                columns={columns}
                liveIndex={liveIndex}
                liveElapsed={liveElapsed}
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

        {/* The price, over the grid rather than beside it: same lanes, same
            rows. It passes through the levels it is being traded against and
            carries on into the window that is still open. */}
        <Trace
          candles={candles}
          strikes={strikes}
          rowHeight={rowHeight}
          now={now}
          from={boardFrom}
          to={boardTo}
          spotAt={spotAt}
          spotE8={spotE8}
        />
      </div>

      <Legend />

      {/* Not over the open cell — the rail beside it is already saying this,
          louder. */}
      {aim?.cell && aim.cell.id !== selectedId && (
        <CellCard cell={aim.cell} rect={aim.rect} now={now} />
      )}
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
      className={`relative flex flex-col items-center gap-0.5 border-l rule px-1 pb-2 pt-1.5 transition-colors ${
        live ? "bg-[color-mix(in_oklab,var(--color-live)_16%,transparent)]" : ""
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
          className="absolute bottom-0 left-0 right-0 h-[3px] overflow-hidden bg-[var(--color-rule)]"
        >
          <span
            className="block h-full bg-[var(--color-live)] transition-[width] duration-1000 ease-linear"
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
  liveIndex,
  liveElapsed,
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
  liveIndex: number;
  liveElapsed: number;
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
      {/* The past, on the chain's own lanes.
          These hold no market — they are the grid the price is drawn on. Ruling
          them exactly like a cell is the whole fix: the verticals now fall on
          the five-minute lattice the columns are already on, so they run the
          width of the board without changing pitch or stopping at a border. The
          row's wash and crosshair run through them too, so pointing at a market
          lights the strike all the way back through the price that made it. */}
      {Array.from({ length: PAST_LANES }, (_, lane) => (
        <div
          key={`past-${lane}`}
          aria-hidden
          onMouseEnter={(event) =>
            onAim({
              row,
              // No column: the past belongs to no expiry, so no head lights up.
              column: -1,
              cell: null,
              rect: event.currentTarget.getBoundingClientRect(),
            })
          }
          className={`cell border-b border-l rule ${atm ? "atm" : ""} ${aimedRow ? "aimed" : ""}`}
          style={{ height: rowHeight }}
        />
      ))}

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
            spent={index === liveIndex ? liveElapsed : null}
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
        className={`relative flex items-center justify-end gap-2 border-b border-l rule px-2 transition-colors ${
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
 * Turns the two-channel ink into a CSS colour.
 *
 * Toward the ground, not toward white. Cutting the pastels with white made a
 * deep book paint a *light* cell, which put pale type on a pale fill and cost
 * the board the one number it exists to show: the deeper the market, the harder
 * its multiple was to read. Cut with the dusk instead and the cell stays dark at
 * every depth, so the side's own colour carries the number the whole way and no
 * arithmetic is needed to decide what shade the type should be.
 *
 * Hue is the side, saturation is conviction, alpha is how much is resting.
 */
function fillFor(ink: TileInk): string {
  if (ink.side === "none" || ink.presence === 0) return "transparent";
  // Toward the neutral, so a market at fifty cents is grey: the book has no
  // opinion and the cell should not pretend otherwise.
  const hue = `color-mix(in oklab, var(--color-${ink.side}) ${(
    32 +
    ink.conviction * 62
  ).toFixed(0)}%, var(--color-foam-faint))`;
  // Low ceiling on purpose. Above about a third the cell goes light enough to
  // swallow its own number, which is the trade the balloons lost.
  const alpha = (6 + ink.presence * 28).toFixed(1);
  return `color-mix(in oklab, ${hue} ${alpha}%, transparent)`;
}

/** The spent fraction, as the custom property the wash reads. */
const spentPercent = (spent: number | null) =>
  spent === null ? undefined : `${(spent * 100).toFixed(1)}%`;

function Tile({
  cell,
  maxDepth,
  rowHeight,
  closed,
  atm,
  spent,
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
  /**
   * How much of this cell's window has already gone, or null off the live
   * column. The board's one hard edge used to be the join between the trace and
   * the chain; the clock has no such edge, because the open window is half
   * spent already. Drawing that inside the column puts the boundary where it
   * belongs — moving, and crossable by the price line.
   */
  spent: number | null;
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

  // No market at this (expiry, strike) yet — the roller has not opened it. The
  // grid's own rules draw the square, which is all it needs: present, empty, and
  // visibly not something you can click.
  if (!cell) {
    return (
      <div
        aria-hidden
        onMouseEnter={take}
        className={`cell border-b border-l rule ${atm ? "atm" : ""} ${aimed ? "aimed" : ""} ${
          spent === null ? "" : "spent"
        }`}
        style={{ height: rowHeight, "--spent": spentPercent(spent) } as React.CSSProperties}
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
      onMouseEnter={take}
      onFocus={take}
      onBlur={() => onAim(null)}
      className={`tile cell sweep flex flex-col items-center justify-center gap-1 border-b border-l rule ${
        atm ? "atm" : ""
      } ${aimed ? "aimed" : ""} ${spent === null ? "" : "spent"}`}
      style={
        {
          height: rowHeight,
          "--fill": fillFor(ink),
          "--spent": spentPercent(spent),
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
 * Where the price has been, drawn on the board's own grid.
 *
 * A layer over the chain, not a panel beside it. The lanes underneath are five
 * minutes each and so is this scale, so an instant lands at the same x whether
 * it falls in a past lane or in a column the chain is still quoting. That is
 * what lets the line run *into* the live window instead of stopping dead at a
 * border, and what makes a closed column show the path that settled it.
 *
 * It rules nothing. Rows and lanes are the cells' own edges — the same hairline
 * across the whole surface — so all that is drawn here is the price, the level
 * it is at, and now.
 */
function Trace({
  candles,
  strikes,
  rowHeight,
  now,
  from,
  to,
  spotAt,
  spotE8,
}: {
  candles: Candle[];
  strikes: bigint[];
  rowHeight: number;
  now: number;
  /** Board time at x = 0: `PAST_LANES` windows before the first column opens. */
  from: number;
  /** Board time at the right edge of the lanes: the last expiry on the board. */
  to: number;
  spotAt: ReturnType<typeof locateOnLadder>;
  spotE8: bigint | null;
}) {
  const { t } = useI18n();
  const clock = useClock();
  const { ref, width } = useMeasured<HTMLDivElement>();

  const height = strikes.length * rowHeight;
  const span = Math.max(to - from, 1);
  const toX = useCallback((unix: number) => ((unix - from) / span) * width, [from, span, width]);

  const ladder = useMemo(() => strikes.map(e8ToUsd), [strikes]);

  /**
   * Price to y, as a scale rather than a rank.
   *
   * `locateOnLadder` answers "which row is this on", and has nothing to say
   * about a price that is on no row at all — so the trace was throwing those
   * candles away. On a calm half hour that was already a sixth of them, and the
   * ones it dropped were the excursions: exactly the moments a board about
   * "will BTC be above X" exists to show. Off the ladder the line now keeps
   * going at the ladder's own spacing and leaves the board through the top or
   * the bottom, which is both true and legible.
   */
  const priceToY = useCallback(
    (priceUsd: number): number => {
      const rows = ladder.length;
      if (rows === 0) return 0;
      if (rows === 1) return 0.5 * rowHeight;

      const top = ladder[0]!;
      const bottom = ladder[rows - 1]!;

      if (priceUsd <= top && priceUsd >= bottom) {
        for (let i = 0; i < rows - 1; i++) {
          const upper = ladder[i]!;
          const lower = ladder[i + 1]!;
          if (priceUsd <= upper && priceUsd >= lower) {
            const fraction = upper === lower ? 0 : (upper - priceUsd) / (upper - lower);
            return (i + 0.5 + fraction) * rowHeight;
          }
        }
      }

      if (priceUsd > top) {
        const step = ladder[0]! - ladder[1]! || 1;
        return (0.5 - (priceUsd - top) / step) * rowHeight;
      }
      const step = ladder[rows - 2]! - ladder[rows - 1]! || 1;
      return (rows - 0.5 + (bottom - priceUsd) / step) * rowHeight;
    },
    [ladder, rowHeight],
  );

  /**
   * Segments, not one polyline: a hole in the feed must not be drawn as a move
   * the price never made. A hole is now the only thing that breaks the line —
   * it used to break wherever the price stepped off the visible ladder, which
   * is a fact about the board, not about the feed.
   */
  const segments = useMemo(() => {
    if (width === 0 || candles.length === 0) return [];

    const runs: string[][] = [];
    let run: string[] = [];
    let previous: number | null = null;

    for (const candle of candles) {
      if (candle.time < from || candle.time > now) continue;
      // Candles are one minute apart; two missing in a row is a real gap.
      if (previous !== null && candle.time - previous > 150) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      run.push(`${toX(candle.time).toFixed(1)},${priceToY(candle.close).toFixed(1)}`);
      previous = candle.time;
    }
    if (run.length > 0) runs.push(run);

    /**
     * The last point is the live price, at now.
     *
     * The candle feed runs minutes behind — measured at 224 seconds — so the
     * line used to stop short of the dot that marks the same price, and the two
     * disagreed about where BTC was. They are the same series; they should meet.
     * Now that the board is one scale, meeting them also carries the line over
     * the lane boundary and into the window that is still open.
     */
    if (spotE8 !== null) {
      const last = runs[runs.length - 1];
      const y = priceToY(e8ToUsd(spotE8));
      if (last && previous !== null && now - previous <= 15 * 60) {
        last.push(`${toX(now).toFixed(1)},${y.toFixed(1)}`);
      }
    }

    return runs.filter((points) => points.length > 1).map((points) => points.join(" "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, width, rowHeight, strikes, now, spotE8, priceToY, toX, from]);

  /**
   * The past lanes, named.
   *
   * On the five-minute lattice, which is the only pitch on this board now — the
   * ten-minute marks the trace used to keep were the visible half of it being a
   * chart of its own. The column heads name the future, so these stop where the
   * chain starts and the axis reads as one run of times.
   */
  const ticks = useMemo(() => {
    const out: number[] = [];
    const firstOpen = from + PAST_LANES * WINDOW_SECONDS;
    for (let ts = from; ts < firstOpen; ts += WINDOW_SECONDS) out.push(ts);
    return out;
  }, [from]);

  const nowX = toX(now);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute left-0 top-0"
      style={{ right: AXIS_WIDTH, height }}
    >
      <svg width="100%" height={height} className="block">
        {width > 0 && (
          <defs>
            {/* The wake: older price is fainter. Measured along the line rather
                than across the box — the line stops at now, and a box-relative
                gradient would leave it fading toward a place it never reaches. */}
            <linearGradient id="wake" gradientUnits="userSpaceOnUse" x1={0} x2={nowX} y1={0} y2={0}>
              <stop offset="0%" stopColor="var(--color-trace)" stopOpacity="0.12" />
              <stop offset="65%" stopColor="var(--color-trace)" stopOpacity="0.55" />
              <stop offset="100%" stopColor="var(--color-trace)" stopOpacity="1" />
            </linearGradient>
          </defs>
        )}

        {/* The times the past lanes cover, in line with the column heads above. */}
        {width > 0 &&
          ticks.map((ts) => (
            <text
              key={ts}
              x={toX(ts) + 5}
              y={12}
              fontSize={9}
              fill="var(--color-foam-faint)"
              fontFamily="var(--font-data)"
            >
              {clock(ts)}
            </text>
          ))}

        {/* Spot, level across the whole board.
            It stopped at now before, when there was a border there to stop at.
            Carried through, it is the line every strike on the board is a bet
            about — and it lands on the badge already riding the axis. */}
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

        {/* Now: a mark inside the open window, not a wall between two panels. */}
        {width > 0 && (
          <g>
            <line
              x1={nowX}
              x2={nowX}
              y1={0}
              y2={height}
              stroke="var(--color-trace)"
              strokeWidth={1}
              opacity={0.5}
            />
            <text
              x={nowX + 5}
              y={12}
              fontSize={9}
              fill="var(--color-trace)"
              fontFamily="var(--font-data)"
            >
              {t("board.now")}
            </text>
          </g>
        )}

        {spotAt?.on === "ladder" && width > 0 && (
          <circle cx={nowX} cy={spotAt.offset * rowHeight} r={5} fill="var(--color-trace)" />
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
  const contracts = Math.round(sizeToContracts(cell.depth));

  /**
   * What each leg costs, off its own book.
   *
   * This used to print the tile's mid for YES and a hundred minus it for NO —
   * two numbers, one of which was invented. The rail beside it reads the actual
   * offers, so hovering a cell and opening it gave different prices for the same
   * market, and the NO price had never been quoted by anyone. Two books, two
   * asks, and the spread below says how they sit against the mid on the tile.
   */
  const ask = (side: "yes" | "no") => {
    const leg = cell.legs[side];
    if (!leg) return null;
    if (leg.bestAsk) return tickToCents(BigInt(leg.bestAsk));
    return leg.bestBid ? tickToCents(BigInt(leg.bestBid)) : null;
  };
  const yes = ask("yes");
  const no = ask("no");

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

      {yes === null && no === null ? (
        <p className="label mt-2">{t("board.noDepth")}</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <Leg side="yes" cents={yes} />
            <Leg side="no" cents={no} />
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

function Leg({ side, cents }: { side: "yes" | "no"; cents: number | null }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-col gap-0.5">
      <span className="label" style={{ color: `var(--color-${side})` }}>
        {t(`ticket.${side}` as const)}
      </span>
      <span className="readout text-[20px] leading-none" style={{ color: `var(--color-${side})` }}>
        {cents === null ? "—" : formatCents(cents)}
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
