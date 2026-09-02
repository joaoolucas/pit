"use client";

import { useMemo, useState } from "react";

import { CELL_POLL_MS, chain, UNDERLYING } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import {
  CELL_QUERY,
  usePolledQuery,
  type RawCellState,
  type RawFill,
  type RawFlow,
  type RawLevel,
  type RawMaker,
} from "@/lib/indexer";
import { DepthLadder } from "./DepthLadder";
import { Notes } from "./Notes";
import { FlowChart, Makers, Tape } from "./Tape";
import { Ticket, type LegQuote } from "./Ticket";
import type { BoardCell } from "./types";
import {
  cellKey as makeCellKey,
  e8ToUsd,
  formatCents,
  formatClock,
  Outcome,
  shortAddress,
  sizeToContracts,
  tickToCents,
  WINDOW_SECONDS,
  type Side,
} from "@pit/core";

type CellQueryResult = {
  CellState: RawCellState[];
  bids: RawLevel[];
  asks: RawLevel[];
  fills: RawFill[];
  flow: RawFlow[];
  liveMakers: RawMaker[];
};

type Tab = "book" | "tape" | "flow" | "notes";

/**
 * One cell, opened.
 *
 * The header is the spine of an option chain: the YES price, the strike, and the
 * NO price, side by side. Putting them on one line is not decoration — it is the
 * fastest way to see the only economic fact that matters here, which is that the
 * two legs are two halves of one dollar. And because they are two *separate*
 * books rather than one AMM, their sum drifts, and when it drifts below a
 * hundred cents that is a risk-free trade sitting on the screen. No payout tile
 * can show you that, because a payout tile has nothing to disagree with.
 */
export function CellPanel({
  cell,
  now,
  onRequireRisk,
}: {
  cell: BoardCell;
  now: number;
  onRequireRisk: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [side, setSide] = useState<Side>("yes");
  const [tab, setTab] = useState<Tab>("book");
  const [pickedCents, setPickedCents] = useState<number | null>(null);

  const leg = cell.legs[side];
  const market = leg?.id ?? "";

  const { data, error } = usePolledQuery<CellQueryResult>(
    CELL_QUERY,
    { market, since: String(cell.endTs - WINDOW_SECONDS * 2) },
    CELL_POLL_MS,
    Boolean(market),
  );

  const state = data?.CellState?.[0] ?? leg;
  const remaining = cell.endTs - now;
  const settled = cell.outcome !== Outcome.Unresolved;
  const elapsed = Math.min(Math.max(1 - remaining / WINDOW_SECONDS, 0), 1);

  const quotes = useMemo<Record<Side, LegQuote | null>>(() => {
    const build = (option: Side): LegQuote | null => {
      const row = cell.legs[option];
      if (!row) return null;
      return {
        side: option,
        market: row.id,
        askCents: row.bestAsk ? tickToCents(BigInt(row.bestAsk)) : null,
        bidCents: row.bestBid ? tickToCents(BigInt(row.bestBid)) : null,
      };
    };
    return { yes: build("yes"), no: build("no") };
  }, [cell.legs]);

  /**
   * What both legs cost together. Two separate order books have no obligation to
   * agree, so this is the arbitrage the design exists to surface.
   */
  const pair = useMemo(() => {
    const yes = quotes.yes?.askCents;
    const no = quotes.no?.askCents;
    if (yes == null || no == null) return null;
    const sum = yes + no;
    return { yes, no, sum, edge: 100 - sum };
  }, [quotes]);

  const cellKey = makeCellKey({ underlying: UNDERLYING, endTs: cell.endTs, strikeE8: cell.strikeE8 });

  return (
    <aside className="flex h-full min-h-0 flex-col border-l rule bg-[var(--color-hull)]">
      <header className="shrink-0 border-b rule">
        <div className="px-4 pb-3 pt-3.5">
          <h2 className="mb-1 text-[13px] font-semibold leading-snug">
            {t("cell.claim", {
              strike: `$${e8ToUsd(cell.strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
            })}
          </h2>
          <p className="data flex items-baseline gap-2 text-[11px] text-[var(--color-foam-faint)]">
            <span>
              {t("cell.closes", {
                time: new Date(cell.endTs * 1000).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </span>
            <span
              className="readout font-medium"
              style={{
                color: settled
                  ? "var(--color-foam-faint)"
                  : remaining < 60
                    ? "var(--color-live)"
                    : "var(--color-foam-dim)",
              }}
            >
              {settled ? t("cell.expired") : formatClock(remaining)}
            </span>
          </p>
        </div>

        {!settled && (
          <div className="h-[2px] w-full bg-[var(--color-rule)]">
            <div
              className="h-full bg-[var(--color-live)] transition-[width] duration-1000 ease-linear"
              style={{ width: `${(elapsed * 100).toFixed(1)}%` }}
            />
          </div>
        )}

        {/* The spine.
            YES, the strike, NO — in that order, because the point of putting
            them on one line is that the two prices are two halves of one
            dollar and the strike is what they are halves of. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch border-t rule">
          <LegPrice
            side="yes"
            quote={quotes.yes}
            active={side === "yes"}
            align="start"
            onPick={() => setSide("yes")}
          />

          <div className="flex flex-col items-center justify-center border-x rule px-3.5 py-2.5">
            <span className="label">{t("board.strike")}</span>
            <span className="data text-[12px] text-[var(--color-foam-dim)]">
              {e8ToUsd(cell.strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
          </div>

          <LegPrice
            side="no"
            quote={quotes.no}
            active={side === "no"}
            align="end"
            onPick={() => setSide("no")}
          />
        </div>

        {pair && <PairLine {...pair} />}
      </header>

      <nav className="flex shrink-0 border-b rule">
        {(["book", "tape", "flow", "notes"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className="flex-1 py-2 text-[11px] font-medium uppercase tracking-[0.09em]"
            style={{
              color: tab === option ? "var(--color-foam)" : "var(--color-foam-faint)",
              borderBottom: tab === option ? "1px solid var(--color-trace)" : "1px solid transparent",
              marginBottom: -1,
            }}
          >
            {t(`cell.${option}` as const)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-4 py-3 text-[11px] text-[var(--color-no)]">
            {t("status.indexer")}: {error.message}
          </p>
        )}

        {tab === "book" && (
          <>
            <DepthLadder
              bids={data?.bids ?? []}
              asks={data?.asks ?? []}
              onPickCents={setPickedCents}
            />
            <div className="border-t rule">
              <div className="flex items-baseline justify-between px-4 pt-2.5">
                <span className="label">{t("cell.makers")}</span>
                <span className="data text-[10px] text-[var(--color-foam-faint)]">
                  {state ? Math.round(sizeToContracts(BigInt(state.volume))) : 0} {t("cell.traded")}
                </span>
              </div>
              <Makers makers={data?.liveMakers ?? []} />
            </div>
          </>
        )}

        {tab === "tape" && <Tape fills={data?.fills ?? []} />}
        {tab === "flow" && <FlowChart flow={data?.flow ?? []} />}
        {tab === "notes" && <Notes cellKey={cellKey} />}
      </div>

      <div className="shrink-0 border-t rule">
        <Ticket
          windowId={cell.windowId}
          outcome={cell.outcome}
          legs={quotes}
          pickedCents={pickedCents}
          onRequireRisk={onRequireRisk}
        />
      </div>

      {market && (
        <a
          href={`${chain.explorerUrl}/address/${market}`}
          target="_blank"
          rel="noreferrer"
          className="data shrink-0 border-t rule px-4 py-1.5 text-[10px] text-[var(--color-foam-faint)] transition-colors hover:text-[var(--color-foam-dim)]"
        >
          {t("cell.onKuru", { market: shortAddress(market, 6) })}
        </a>
      )}
    </aside>
  );
}

/**
 * The two legs, added up.
 *
 * Two independent books have no obligation to agree, so this number drifts. Over
 * a dollar it is the overround — the spread you pay on each leg — and saying so
 * is more use than calling it "coherent". Under a dollar it is a free trade, and
 * it says that too: buy both legs for 97¢ and redeem 100¢ whichever way the
 * price goes. An AMM would never let that happen; two order books do, and this
 * line is the only place anyone would notice.
 */
function PairLine({ yes, no, sum, edge }: { yes: number; no: number; sum: number; edge: number }) {
  const { t } = useI18n();
  const arb = edge >= 1;

  return (
    <div
      className="flex items-baseline justify-between gap-3 border-t rule px-4 py-1.5"
      style={{
        background: arb ? "color-mix(in oklab, var(--color-yes) 12%, transparent)" : "transparent",
      }}
    >
      <span className="data text-[10.5px] text-[var(--color-foam-faint)]">
        {formatCents(yes)} + {formatCents(no)} ={" "}
        <span
          className="font-semibold"
          style={{ color: arb ? "var(--color-yes)" : "var(--color-foam-dim)" }}
        >
          {formatCents(sum)}
        </span>
      </span>
      <span
        className="text-right text-[10px] leading-tight"
        style={{ color: arb ? "var(--color-yes)" : "var(--color-foam-faint)" }}
      >
        {arb
          ? t("cell.arb", { edge: `${Math.round(edge)}¢` })
          : t("cell.overround", { over: `${Math.round(-edge)}¢` })}
      </span>
    </div>
  );
}

/** One half of the spine. */
function LegPrice({
  side,
  quote,
  active,
  align,
  onPick,
}: {
  side: Side;
  quote: LegQuote | null;
  active: boolean;
  align: "start" | "end";
  onPick: () => void;
}) {
  const { t } = useI18n();
  const price = quote?.askCents ?? quote?.bidCents ?? null;

  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex flex-col gap-0.5 px-4 py-2.5 ${align === "end" ? "items-end" : "items-start"}`}
      style={{
        background: active
          ? `color-mix(in oklab, var(--color-${side}) 10%, transparent)`
          : "transparent",
      }}
    >
      <span className="label" style={{ color: active ? `var(--color-${side})` : undefined }}>
        {t(`ticket.${side}` as const)}
      </span>
      <span
        className="readout text-[21px] font-semibold leading-none"
        style={{ color: active ? `var(--color-${side})` : "var(--color-foam-dim)" }}
      >
        {price == null ? "—" : formatCents(price)}
      </span>
    </button>
  );
}
