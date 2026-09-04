"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { rollCommand } from "@/lib/config";
import { useClock, useI18n } from "@/lib/i18n";
import type { Candle, PricePoint } from "@/lib/usePrice";
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

/**
 * Rows never get thinner than this.
 *
 * The multiple is the headline and it was being read out of a letterbox: a
 * hundred-odd pixels wide and seventy tall, which is a strip, not a cell. The
 * board carries the whole width now that nothing is parked beside it, so the
 * height is the half that had to give.
 */
const MIN_ROW_HEIGHT = 84;
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
 * five-minute window wide, and the trace is simply the windows before the first
 * column opens. The price is drawn over that shared grid and carries on into the
 * live column, which is where the price actually is.
 */
const PAST_LANES = 5;
/** Minutes of realised price the past lanes cover. */
const TRACE_MINUTES = (PAST_LANES * WINDOW_SECONDS) / 60;
/** How finely the live end of the price line is drawn. See `points` in Trace. */
const TRAIL_SECONDS = 15;
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
  /** Spot as it arrived, second by second. The live end of the price line. */
  trail: PricePoint[];
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
  trail,
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
  const boardTemplate = `repeat(${laneCount}, minmax(88px, 1fr)) ${AXIS_WIDTH}px`;

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
          trail={trail}
          strikes={strikes}
          rowHeight={rowHeight}
          now={now}
          from={boardFrom}
          to={boardTo}
          liveFrom={liveIndex === -1 ? null : columns[liveIndex]! - WINDOW_SECONDS}
          spotE8={spotE8}
        />
      </div>

      <Legend />

      {/* Not over the open cell — the rail beside it is already saying this,
          louder. */}
      {aim?.cell && selectedId === null && <CellCard cell={aim.cell} rect={aim.rect} now={now} />}
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
  // Model cells have no resting size; still paint the side so the chain reads
  // like it used to when every tile had a quote.
  if (!settled && cents !== null && ink.presence === 0) ink.presence = 0.45;

  return (
    <button
      type="button"
      onClick={() => onSelect(cell)}
      // The ticket finds its tile by this, and keeps finding it while the board
      // scrolls under it.
      data-cell-id={cell.id}
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
      ) : cell.crossed ? (
        // Not the same as unquoted, and saying so matters: a hollow cell is a
        // market waiting for a maker, this one is a market whose book cannot be
        // read. Both are untradeable; only one is anybody's fault.
        <span className="label text-[9px] leading-none text-[var(--color-no)]">
          {t("board.crossed")}
        </span>
      ) : cents === null ? (
        // "–" made an unquoted market look like a rendering gap. It is a market
        // with nobody on either side, and the legend already promises that a
        // hollow tile means exactly that — so it may as well say it.
        <span className="label text-[9px] leading-none">{t("board.noDepth")}</span>
      ) : (
        <>
          <span
            className="readout text-[26px] leading-none sm:text-[29px]"
            style={{ color: `var(--color-${ink.side === "no" ? "no" : "yes"})` }}
          >
            {formatMultiple(cents)}
          </span>
          {/* What it costs. How deep it is, the paint already said. */}
          <span className="data text-[12px] leading-none text-[var(--color-foam-dim)]">
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
 *
 * Two feeds, one line. Candles carry the older stretch at a point a minute;
 * `trail` carries the last few minutes at a point a second, which is the part
 * being traded and the part worth having at that resolution. Past the newest
 * reading the tip is animated rather than rendered — see below.
 */
function Trace({
  candles,
  trail,
  strikes,
  rowHeight,
  now,
  from,
  to,
  liveFrom,
  spotE8,
}: {
  candles: Candle[];
  trail: PricePoint[];
  strikes: bigint[];
  rowHeight: number;
  now: number;
  /** Board time at x = 0: `PAST_LANES` windows before the first column opens. */
  from: number;
  /** Board time at the right edge of the lanes: the last expiry on the board. */
  to: number;
  /** When the open window opened, or null if every column has closed. */
  liveFrom: number | null;
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
   * The two feeds, spliced.
   *
   * Candles stop where the trail starts, so the minutes the browser has been
   * watching are drawn from what it watched and everything before them from what
   * the exchange reports. They are the same series at two rates, and the join is
   * just the moment this tab opened.
   *
   * The trail is thinned on the way in, and thinned by averaging.
   *
   * Drawn at the rate it arrives it was a thicket beside a smooth line, and the
   * difference was the sampling, not the market: a candle is a minute's close,
   * so a minute of ticking inside it is invisible by construction, while spot at
   * a second shows every twenty-dollar jog. Side by side that reads as
   * volatility arriving, which is a thing the chart would be saying and BTC
   * would not.
   *
   * Keeping one reading per slot fixed the density and kept all of the jitter —
   * one sample in fifteen carries the full tick noise at a fifteenth of the
   * detail, which is the worst of both. The slot's mean uses every reading it
   * has, so what is left is where the price was rather than where it happened to
   * be sampled. On a ladder where a dollar is two pixels tall, that is the
   * difference between a line and a tremor.
   */
  const points = useMemo(() => {
    const out: PricePoint[] = [];
    const trailFrom = trail[0]?.t ?? Infinity;

    for (const candle of candles) {
      if (candle.time < from || candle.time > now) continue;
      if (candle.time >= trailFrom) break;
      out.push({ t: candle.time, usd: candle.close });
    }

    const open = Math.floor(now / TRAIL_SECONDS);
    let slot = -Infinity;
    let sum = 0;
    let count = 0;

    // The mean sits in the middle of the slot it is the mean of.
    const flush = () => {
      if (count > 0) out.push({ t: (slot + 0.5) * TRAIL_SECONDS, usd: sum / count });
      sum = 0;
      count = 0;
    };

    for (const point of trail) {
      if (point.t < from) continue;
      const at = Math.floor(point.t / TRAIL_SECONDS);
      // The slot the clock is still inside is not a point yet: it would move
      // every second, and the live leg already draws that stretch.
      if (at >= open) break;
      if (at !== slot) {
        flush();
        slot = at;
      }
      sum += point.usd;
      count += 1;
    }
    flush();

    return out;
  }, [candles, trail, from, now]);

  /** The newest reading. Everything to the right of it is animated, not drawn. */
  const tail = points[points.length - 1] ?? null;
  const live = tail !== null && now - tail.t <= 15 * 60;

  /**
   * Segments, not one polyline: a hole in the feed must not be drawn as a move
   * the price never made. A hole is now the only thing that breaks the line —
   * it used to break wherever the price stepped off the visible ladder, which
   * is a fact about the board, not about the feed.
   */
  const segments = useMemo(() => {
    if (width === 0 || points.length === 0) return [];

    const runs: string[][] = [];
    let run: string[] = [];
    let previous: number | null = null;

    for (const point of points) {
      // Candles are a minute apart and the trail a second; two missing minutes
      // is a real gap either way.
      if (previous !== null && point.t - previous > 150) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      run.push(`${toX(point.t).toFixed(1)},${priceToY(point.usd).toFixed(1)}`);
      previous = point.t;
    }
    if (run.length > 0) runs.push(run);

    return runs.filter((run) => run.length > 1).map((run) => run.join(" "));
  }, [points, width, toX, priceToY]);

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

  /**
   * The tip, animated rather than rendered.
   *
   * Everything to the right of the newest reading moves continuously: now slides
   * left at one second per second, and the price it points at should arrive
   * rather than jump. Doing that through React would re-render the board sixty
   * times a second to move four numbers, so the frame loop writes the attributes
   * itself and React keeps the parts that only change when the data does.
   */
  const nowLine = useRef<SVGLineElement>(null);
  const nowLabel = useRef<SVGTextElement>(null);
  const beat = useRef<SVGLineElement>(null);
  const level = useRef<SVGLineElement>(null);
  const leg = useRef<SVGLineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const halo = useRef<SVGCircleElement>(null);

  const frame = useRef({
    width,
    rowHeight,
    toX,
    priceToY,
    tail,
    live,
    spotUsd: null as number | null,
  });
  useEffect(() => {
    frame.current = {
      width,
      rowHeight,
      toX,
      priceToY,
      tail,
      live,
      spotUsd: spotE8 === null ? null : e8ToUsd(spotE8),
    };
  });

  /**
   * The tip, every frame.
   *
   * Easing the tip's y was tried once and taken out: with the drawn line ending
   * *at* the tip there was no horizontal distance for the lag to resolve over,
   * so a falling price closed the two into a vertical needle. The line stops at
   * the last closed slot now, which leaves the live leg fifteen seconds — seven
   * or eight pixels — to swing through, and over that the lag reads as the
   * rotation it is. Spot arrives in twenty-dollar steps, forty pixels at this
   * ladder's spacing; landing them over about a fifth of a second is the
   * difference between a price that moves and one that teleports.
   *
   * Snapped, not eased, when the jump is bigger than a row: that is the ladder
   * re-centring under the line, and gliding across it would draw a move BTC
   * never made.
   */
  useEffect(() => {
    let raf = 0;
    let drawn: number | null = null;

    const paint = () => {
      raf = requestAnimationFrame(paint);
      const g = frame.current;
      if (g.width === 0) return;

      const x = g.toX(Date.now() / 1000);
      for (const mark of [nowLine.current, beat.current]) {
        mark?.setAttribute("x1", `${x}`);
        mark?.setAttribute("x2", `${x}`);
      }
      nowLabel.current?.setAttribute("x", `${x + 5}`);

      if (g.spotUsd === null || !g.live || !g.tail) return;

      const target = g.priceToY(g.spotUsd);
      drawn =
        drawn === null || Math.abs(target - drawn) > g.rowHeight
          ? target
          : drawn + (target - drawn) * 0.22;

      level.current?.setAttribute("y1", `${drawn}`);
      level.current?.setAttribute("y2", `${drawn}`);
      leg.current?.setAttribute("x1", `${g.toX(g.tail.t)}`);
      leg.current?.setAttribute("y1", `${g.priceToY(g.tail.usd)}`);
      leg.current?.setAttribute("x2", `${x}`);
      leg.current?.setAttribute("y2", `${drawn}`);
      for (const mark of [dot.current, halo.current]) {
        mark?.setAttribute("cx", `${x}`);
        mark?.setAttribute("cy", `${drawn}`);
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);

  const tailX = tail ? toX(tail.t) : 0;

  return (
    <div
      ref={ref}
      aria-hidden
      className="trace pointer-events-none absolute left-0 top-0"
      style={{ right: AXIS_WIDTH, height }}
    >
      <svg width="100%" height={height} className="block">
        {width > 0 && (
          <defs>
            {/* The wake: older price is fainter. Measured along the line rather
                than across the box — the line ends at the newest reading, and a
                box-relative gradient would fade toward a place it never reaches. */}
            <linearGradient id="wake" gradientUnits="userSpaceOnUse" x1={0} x2={tailX} y1={0} y2={0}>
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
        {live && (
          <line
            ref={level}
            x1={0}
            x2="100%"
            y1={-1}
            y2={-1}
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

        {/* Minutes, inside the open window only.
            Now crosses this board at about half a pixel a second, which is real
            movement and unreadable movement: there is nothing beside it to be
            moving against. Four marks give the open five minutes a ruler, so the
            gap between the last one crossed and the line is a quantity you can
            read — and every minute the line visibly clears another. Only here,
            because this is the only column where the clock is the trade. */}
        {width > 0 &&
          liveFrom !== null &&
          [1, 2, 3, 4].map((minute) => {
            const x = toX(liveFrom + minute * 60);
            return (
              <line
                key={minute}
                x1={x}
                x2={x}
                y1={0}
                y2={height}
                stroke="var(--color-foam)"
                strokeWidth={1}
                strokeDasharray="1 7"
                opacity={0.18}
              />
            );
          })}

        {/* Now: a mark inside the open window, not a wall between two panels. */}
        {width > 0 && (
          <>
            <line
              ref={nowLine}
              x1={-1}
              x2={-1}
              y1={0}
              y2={height}
              stroke="var(--color-trace)"
              strokeWidth={1}
              opacity={0.5}
            />
            {/* The second hand.
                Half a pixel a second is below the rate anything reads as motion,
                so the board looked stopped between one countdown tick and the
                next. This beats once a second in place. It says nothing the
                countdown does not; it says it at a rate the eye picks up
                without being read. */}
            <line
              ref={beat}
              className="now-beat"
              x1={-1}
              x2={-1}
              y1={0}
              y2={22}
              stroke="var(--color-trace)"
              strokeWidth={3}
              strokeLinecap="round"
            />
            <text
              ref={nowLabel}
              x={-1}
              y={12}
              fontSize={9}
              fill="var(--color-trace)"
              fontFamily="var(--font-data)"
            >
              {t("board.now")}
            </text>
          </>
        )}

        {/* The last second, and the price at the end of it. */}
        {live && (
          <>
            <line
              ref={leg}
              x1={-1}
              x2={-1}
              y1={-1}
              y2={-1}
              stroke="var(--color-trace)"
              strokeWidth={2.4}
              strokeLinecap="round"
            />
            <circle ref={halo} className="tip-halo" cx={-1} cy={-1} r={5} fill="var(--color-trace)" />
            <circle ref={dot} cx={-1} cy={-1} r={5} fill="var(--color-trace)" />
          </>
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
      {/* The line used to need naming. It runs the width of the board now and
          ends on the price the header is printing, so a swatch for it was one
          more thing in a row that had four. */}

      {/* The board is a grid of buttons and nothing about a grid says so. */}
      <span className="label ml-auto text-[var(--color-foam-dim)]">
        {t("board.legendHint")}
      </span>
    </div>
  );
}
