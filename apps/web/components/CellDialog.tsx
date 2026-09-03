"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useClock, useI18n } from "@/lib/i18n";
import { CellPanel, legQuotes } from "./CellPanel";
import { Ticket } from "./Ticket";
import type { BoardCell } from "./types";
import { e8ToUsd, formatCents, formatClock, Outcome, WINDOW_SECONDS } from "@pit/core";

/** The quick ticket. Wide enough for two prices side by side and nothing else. */
const QUICK_WIDTH = 320;
/** Everything else about the cell: the book, the tape, the flow, the notes. */
const FULL_WIDTH = 380;
const GAP = 10;
/** Below this the board has no room beside a tile, so the ticket docks instead. */
const DOCK_BELOW = 900;

/**
 * A cell, opened against itself.
 *
 * This used to be a rail: three hundred and sixty pixels of permanent furniture
 * on the right, empty and saying "Pick a cell" for as long as you had not picked
 * one. It cost the board a quarter of its width for a panel that was blank most
 * of the time, and it put the market you clicked and the ticket you clicked it
 * for at opposite ends of the screen.
 *
 * Opening it against the tile costs nothing until it is wanted, gives the whole
 * width back to the grid, and keeps the claim, the price and the ticket in one
 * glance. The board stays live behind it — this is a popover, not a modal, so
 * the next cell is one click away and clicking it simply moves the ticket.
 *
 * It opens on the trade and nothing else. Clicking a tile is someone deciding
 * they want a side at a price; the depth ladder, the tape, the flow chart, the
 * two-leg arithmetic and the maker list are all answers to questions asked
 * *before* that click, and every one of them was on screen above the amount
 * field. They are a tap away instead. The exception is a free trade — the two
 * legs summing under a dollar — which is the one fact that changes what you
 * should do next, so it appears exactly when it is true.
 *
 * On a narrow screen there is nothing to anchor to, so it docks to the bottom.
 */
export function CellDialog({
  cell,
  now,
  onClose,
  onRequireRisk,
}: {
  cell: BoardCell;
  now: number;
  onClose: () => void;
  onRequireRisk: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const clock = useClock();
  const panel = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; docked: boolean } | null>(null);

  const width = full ? FULL_WIDTH : QUICK_WIDTH;

  /**
   * Follow the tile.
   *
   * The rectangle is read off the board rather than passed in from the click,
   * because a click's rectangle is a fact about one instant: the board scrolls,
   * the window resizes, and the ladder re-centres on its own every few hundred
   * dollars. Any of those and a remembered rectangle points at nothing.
   */
  useLayoutEffect(() => {
    const place = () => {
      if (window.innerWidth < DOCK_BELOW) {
        setBox({ left: 0, top: 0, docked: true });
        return;
      }

      const tile = document.querySelector(`[data-cell-id="${CSS.escape(cell.id)}"]`);
      const rect = tile?.getBoundingClientRect();
      if (!rect) return;

      const height = panel.current?.offsetHeight ?? 0;
      const room = window.innerWidth - rect.right;
      const left =
        room > width + GAP * 2 ? rect.right + GAP : Math.max(GAP, rect.left - width - GAP);
      // Level with the tile where it fits, nudged back inside the viewport where
      // it does not — a ticket half off the bottom of the screen is no ticket.
      const top = Math.min(Math.max(GAP, rect.top - 24), window.innerHeight - height - GAP);

      setBox({ left, top: Math.max(GAP, top), docked: false });
    };

    place();
    window.addEventListener("resize", place);
    // Capture: the board is its own scroll container, and a scroll there moves
    // the tile without the window ever scrolling.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [cell.id, width, full]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    /**
     * Dismissed on the way down, not on the click.
     *
     * A pointer down outside closes this before the click that follows it lands,
     * so clicking a second cell reads as moving the ticket rather than as
     * closing one and opening another.
     */
    const onDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const docked = box?.docked ?? false;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={cell.title}
      className="pop fixed z-40 flex flex-col"
      style={
        docked
          ? { left: GAP, right: GAP, bottom: GAP, maxHeight: "min(70vh, 34rem)" }
          : {
              left: box?.left ?? -9999,
              top: box?.top ?? -9999,
              width,
              ...(full ? { height: "min(78vh, 40rem)" } : { maxHeight: "min(78vh, 40rem)" }),
            }
      }
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t("cell.close")}
        title={t("cell.close")}
        className="absolute right-2.5 top-2.5 z-10 grid size-7 place-items-center rounded-full text-[15px] leading-none text-[var(--color-foam-faint)] transition-colors hover:bg-[var(--color-deep)] hover:text-[var(--color-foam)]"
      >
        ×
      </button>

      {full ? (
        <CellPanel cell={cell} now={now} onRequireRisk={onRequireRisk} />
      ) : (
        <Quick cell={cell} now={now} clock={clock} onRequireRisk={onRequireRisk} />
      )}

      <button
        type="button"
        onClick={() => setFull((open) => !open)}
        className="shrink-0 border-t rule py-2 text-[10px] font-extrabold uppercase tracking-[0.09em] text-[var(--color-foam-faint)] transition-colors hover:bg-[var(--color-deep)] hover:text-[var(--color-foam-dim)]"
      >
        {full ? t("cell.less") : t("cell.more")}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Pick a side, tap an amount, send. */
function Quick({
  cell,
  now,
  clock,
  onRequireRisk,
}: {
  cell: BoardCell;
  now: number;
  clock: (unix: number) => string;
  onRequireRisk: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const quotes = useMemo(() => legQuotes(cell.legs), [cell.legs]);

  const remaining = cell.endTs - now;
  const settled = cell.outcome !== Outcome.Unresolved;
  const closed = !settled && remaining <= 0;
  const elapsed = Math.min(Math.max(1 - remaining / WINDOW_SECONDS, 0), 1);

  /**
   * The two legs, added up — but only when the sum is news.
   *
   * Two independent books have no obligation to agree. Over a dollar the gap is
   * the overround, which is just the spread and which the two prices on the
   * buttons already imply. Under a dollar it is a free trade: buy both legs for
   * 97¢ and redeem 100¢ whichever way BTC goes. An AMM could never let that
   * happen and two order books do, so it is worth interrupting for — and worth
   * showing *only* then.
   */
  const free = useMemo(() => {
    const yes = quotes.yes?.askCents;
    const no = quotes.no?.askCents;
    if (yes == null || no == null) return null;
    const edge = 100 - (yes + no);
    return edge >= 1 ? { sum: yes + no, edge: Math.round(edge) } : null;
  }, [quotes]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pb-2 pt-3">
        <h2 className="mb-0.5 pr-7 text-[14px] font-extrabold leading-snug">
          {t("cell.claim", {
            strike: `$${e8ToUsd(cell.strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          })}
        </h2>
        <p className="data flex items-baseline gap-2 text-[11px] text-[var(--color-foam-faint)]">
          <span>{t("cell.closes", { time: clock(cell.endTs) })}</span>
          <span
            className="readout font-medium"
            style={{
              color:
                settled || closed
                  ? "var(--color-foam-faint)"
                  : remaining < 60
                    ? "var(--color-live)"
                    : "var(--color-foam-dim)",
            }}
          >
            {settled ? t("cell.expired") : closed ? t("board.settling") : formatClock(remaining)}
          </span>
        </p>
      </header>

      {!settled && !closed && (
        <div className="mx-4 h-[5px] shrink-0 overflow-hidden rounded-full bg-[var(--color-rule)]">
          <div
            className="h-full rounded-full bg-[var(--color-live)] transition-[width] duration-1000 ease-linear"
            style={{ width: `${(elapsed * 100).toFixed(1)}%` }}
          />
        </div>
      )}

      {free && (
        <p
          className="data mx-4 mt-2 shrink-0 rounded-full px-3 py-1 text-center text-[10.5px]"
          style={{
            background: "color-mix(in oklab, var(--color-yes) 12%, transparent)",
            color: "var(--color-yes)",
          }}
        >
          {formatCents(free.sum)} · {t("cell.arb", { edge: `${free.edge}¢` })}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Ticket
          compact
          windowId={cell.windowId}
          outcome={cell.outcome}
          legs={quotes}
          pickedCents={null}
          onRequireRisk={onRequireRisk}
        />
      </div>
    </div>
  );
}
