"use client";

import { useMemo, useRef, useState } from "react";

import { GRID_POLL_MS, UNDERLYING } from "@/lib/config";
import { useClock, useI18n } from "@/lib/i18n";
import { GRID_QUERY, usePolledQuery, type RawCellState } from "@/lib/indexer";
import { useCandles, useNow, useSpot, useSpotTrail } from "@/lib/usePrice";
import { Board, cellId } from "./Board";
import { CellDialog } from "./CellDialog";
import { Header } from "./Header";
import { RiskDialog, useRiskGate } from "./RiskGate";
import type { BoardCell } from "./types";
import {
  e8ToUsd,
  formatCents,
  Outcome,
  tickToCents,
  upcomingWindowEnds,
  visibleStrikes,
  WINDOW_SECONDS,
  type Side,
} from "@pit/core";

/**
 * One settled column is kept on the board, immediately left of the live one.
 *
 * The trace covers the past now, so older columns would be dead weight — but the
 * most recent settle is the proof that settlement happens at all, and it belongs
 * where the price that decided it is still on screen.
 */
const SETTLED_COLUMNS = 1;
const FUTURE_COLUMNS = 6;
/**
 * How many strikes the ladder shows.
 *
 * Nine fitted when a row was seventy pixels tall and the board was three
 * quarters of the screen. It is neither now — the rail is gone and a cell is a
 * cell rather than a strip — and nine of the taller rows would put the board
 * under a scrollbar, which costs more than the two outermost strikes, the ones
 * furthest from the money and least likely to be traded, are worth.
 */
const LADDER_ROWS = 7;

export function Terminal() {
  const { t } = useI18n();
  const clock = useClock();
  const now = useNow();
  const { priceE8 } = useSpot(UNDERLYING);
  const trail = useSpotTrail(priceE8);
  const candles = useCandles(UNDERLYING);
  const risk = useRiskGate();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Recomputed from `now` but snapped to window boundaries, so it only actually
  // changes once every five minutes.
  const columns = useMemo(() => {
    const upcoming = upcomingWindowEnds(now, FUTURE_COLUMNS);
    const first = upcoming[0]!;
    const settled = Array.from(
      { length: SETTLED_COLUMNS },
      (_, i) => first - (SETTLED_COLUMNS - i) * WINDOW_SECONDS,
    );
    return [...settled, ...upcoming];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(now / WINDOW_SECONDS)]);

  const { data, error, loading, updatedAt } = usePolledQuery<{ CellState: RawCellState[] }>(
    GRID_QUERY,
    {
      endTsFrom: String(columns[0] ?? 0),
      endTsTo: String(columns[columns.length - 1] ?? 0),
      underlying: UNDERLYING,
    },
    GRID_POLL_MS,
  );

  /**
   * Two indexer rows per window — the YES market and the NO market — folded into
   * one tile each, keyed by (expiry, strike).
   */
  const { cells, allStrikes } = useMemo(() => {
    const byCell = new Map<string, BoardCell>();
    const strikeSet = new Map<string, bigint>();

    for (const row of data?.CellState ?? []) {
      const endTs = Number(row.endTs);
      const strikeE8 = BigInt(row.strikeE8);
      const id = cellId(endTs, strikeE8);
      strikeSet.set(strikeE8.toString(), strikeE8);

      const existing = byCell.get(id);
      const legs: Record<Side, RawCellState | null> = existing
        ? { ...existing.legs }
        : { yes: null, no: null };
      legs[row.side === "YES" ? "yes" : "no"] = row;

      const read = priceCell(legs);
      const depth =
        (legs.yes ? BigInt(legs.yes.bidDepth) + BigInt(legs.yes.askDepth) : 0n) +
        (legs.no ? BigInt(legs.no.bidDepth) + BigInt(legs.no.askDepth) : 0n);

      const makers = Math.max(legs.yes?.makers ?? 0, legs.no?.makers ?? 0);
      const volume =
        (legs.yes ? BigInt(legs.yes.volume) : 0n) + (legs.no ? BigInt(legs.no.volume) : 0n);

      byCell.set(id, {
        id,
        windowId: Number(row.windowId),
        endTs,
        strikeE8,
        outcome: (row.outcome ?? 0) as Outcome,
        cents: read.cents,
        widthCents: read.widthCents,
        depth,
        makers,
        volume,
        title: describe(t, clock(endTs), strikeE8, read.cents, read.widthCents, makers),
        legs,
      });
    }

    return {
      cells: byCell,
      allStrikes: [...strikeSet.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)),
    };
  }, [data, t, clock]);

  /**
   * The roller opens a fresh ladder every minute, so an hour of drift leaves far
   * more strikes on the board than fit — and the far ones are the ones nobody
   * trades. Show a window around the money, the way a chain does.
   *
   * Held still while the price is comfortably inside it. `visibleStrikes`
   * re-centres on the nearest strike, which means the window slid by a whole row
   * every fifty dollars — and every row the window slides, the entire board and
   * the half hour of price drawn beside it jump seventy-two pixels. The reading
   * stayed correct (the labels move with it) but a chart that teleports while
   * you are reading it is a chart you stop trusting. It now only re-centres when
   * the price reaches the outermost row, so the board holds still for a few
   * hundred dollars at a time.
   */
  const held = useRef<bigint[]>([]);
  const strikes = useMemo(() => {
    const fresh = visibleStrikes(allStrikes, priceE8, LADDER_ROWS);
    const previous = held.current;

    const stillUsable =
      previous.length === fresh.length &&
      previous.length > 2 &&
      priceE8 !== null &&
      // every row still exists on the board
      previous.every((strike) => allStrikes.includes(strike)) &&
      // and the price has not reached the edge of it
      priceE8 <= previous[1]! &&
      priceE8 >= previous[previous.length - 2]!;

    if (stillUsable) return previous;
    held.current = fresh;
    return fresh;
  }, [allStrikes, priceE8]);

  /** Move across the trace window, for the header. */
  const changePct = useMemo(() => {
    if (candles.length < 2 || priceE8 === null) return null;
    const first = candles[0]?.close;
    if (!first || first <= 0) return null;
    return e8ToUsd(priceE8) / first - 1;
  }, [candles, priceE8]);

  const selected = selectedId ? (cells.get(selectedId) ?? null) : null;
  const indexerAge = updatedAt === null ? null : (Date.now() - updatedAt) / 1000;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header
        spotE8={priceE8}
        changePct={changePct}
        indexerAgeSeconds={indexerAge}
        indexerDown={Boolean(error)}
        onOpenRisk={risk.show}
      />

      {/* One surface.
          There were two: the board, and a rail holding the opened cell. The rail
          was three hundred and sixty pixels of the screen whether a cell was
          open or not, and it was not open most of the time — so the board paid
          permanently for something occasional, and the cell you clicked ended up
          as far from its own ticket as the layout could put it. The ticket opens
          against the tile now. The grid gets the width back.

          The frame is Pit; what is inside it is a board. Rounding the surface
          and ruling the grid within it is the whole compromise: the chrome keeps
          the carnival, the instrument keeps its lines. */}
      <main className="min-h-0 flex-1 p-2">
        <section className="panel h-full min-h-0 overflow-hidden rounded-[20px] shadow-[0_6px_0_rgba(20,8,28,0.28)]">
          {error && !data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
              <p className="text-[13px] text-[var(--color-no)]">
                {t("status.indexer")} · {t("status.down")}
              </p>
              <p className="max-w-sm text-[11px] leading-relaxed text-[var(--color-foam-faint)]">
                {error.message}
              </p>
            </div>
          ) : loading && !data ? (
            <div className="flex h-full items-center justify-center">
              <span className="label">{t("status.loading")}</span>
            </div>
          ) : (
            <Board
              columns={columns}
              strikes={strikes}
              cells={cells}
              spotE8={priceE8}
              candles={candles}
              trail={trail}
              now={now}
              selectedId={selectedId}
              onSelect={(cell) => setSelectedId(cell.id)}
            />
          )}
        </section>
      </main>

      {selected && (
        <CellDialog
          cell={selected}
          now={now}
          onClose={() => setSelectedId(null)}
          onRequireRisk={risk.require}
        />
      )}

      <RiskDialog open={risk.open} onAccept={risk.accept} onDismiss={risk.dismiss} />
    </div>
  );
}

/**
 * The YES price of a cell, in cents, from whichever leg has a book.
 *
 * A NO market at 38¢ says the YES is 62¢ even when nobody has quoted YES at all,
 * so reading both legs is not redundancy — it is how a half-quoted cell still
 * gets a price on the board.
 */
function priceCell(legs: Record<Side, RawCellState | null>): {
  cents: number | null;
  widthCents: number | null;
} {
  const yesBid = legs.yes?.bestBid ? tickToCents(BigInt(legs.yes.bestBid)) : null;
  const yesAsk = legs.yes?.bestAsk ? tickToCents(BigInt(legs.yes.bestAsk)) : null;
  const noBid = legs.no?.bestBid ? tickToCents(BigInt(legs.no.bestBid)) : null;
  const noAsk = legs.no?.bestAsk ? tickToCents(BigInt(legs.no.bestAsk)) : null;
  const yesLast = legs.yes?.lastPrice ? tickToCents(BigInt(legs.yes.lastPrice)) : null;

  if (yesBid !== null && yesAsk !== null) {
    return { cents: Math.round((yesBid + yesAsk) / 2), widthCents: yesAsk - yesBid };
  }
  // Read the NO book backwards.
  if (noBid !== null && noAsk !== null) {
    return { cents: Math.round(100 - (noBid + noAsk) / 2), widthCents: noAsk - noBid };
  }
  if (yesLast !== null) return { cents: yesLast, widthCents: null };
  if (yesAsk !== null) return { cents: yesAsk, widthCents: null };
  if (yesBid !== null) return { cents: yesBid, widthCents: null };
  if (noAsk !== null) return { cents: 100 - noAsk, widthCents: null };
  if (noBid !== null) return { cents: 100 - noBid, widthCents: null };
  return { cents: null, widthCents: null };
}

/** Everything a hover should say about a tile, assembled once. */
function describe(
  t: ReturnType<typeof useI18n>["t"],
  time: string,
  strikeE8: bigint,
  cents: number | null,
  widthCents: number | null,
  makers: number,
): string {
  const claim = t("cell.claim", {
    strike: `${e8ToUsd(strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  });

  const parts = [`${claim} · ${t("cell.closes", { time })}`];
  if (cents !== null) parts.push(formatCents(cents));
  if (widthCents !== null) parts.push(t("board.titleWidth", { width: `${widthCents}¢` }));
  if (makers > 0) parts.push(t("board.titleMakers", { makers }));
  return parts.join(" · ");
}
