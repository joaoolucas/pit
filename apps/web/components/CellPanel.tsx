"use client";

import { useState } from "react";

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
import { Notes } from "./Notes";
import { OrderBook } from "./OrderBook";
import { OrderTicket } from "./OrderTicket";
import { FlowChart, Makers, Tape } from "./Tape";
import type { GridCell } from "./types";
import {
  cellKey as makeCellKey,
  e8ToUsd,
  formatClock,
  Outcome,
  sizeToContracts,
  tickToProb,
  type Side,
} from "@cell/core";

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
 * The header answers the three questions a trader asks before anything else:
 * what is the claim, how long is left, and what does it pay. Everything below is
 * the evidence — the live Kuru book, the tape, the signed flow, and who is
 * quoting.
 */
export function CellPanel({
  cell,
  now,
  onRequireRisk,
}: {
  cell: GridCell;
  now: number;
  onRequireRisk: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [side, setSide] = useState<Side>("yes");
  const [tab, setTab] = useState<Tab>("book");
  const [pickedPrice, setPickedPrice] = useState<number | null>(null);

  const leg = cell.legs[side];
  const market = leg?.id ?? "";

  const { data, error } = usePolledQuery<CellQueryResult>(
    CELL_QUERY,
    { market, since: String(cell.endTs - 600) },
    CELL_POLL_MS,
    Boolean(market),
  );

  const state = data?.CellState?.[0] ?? leg;
  const remaining = cell.endTs - now;
  const settled = cell.outcome !== Outcome.Unresolved;

  const bestBid = state?.bestBid ? tickToProb(BigInt(state.bestBid)) : null;
  const bestAsk = state?.bestAsk ? tickToProb(BigInt(state.bestAsk)) : null;
  const last = state?.lastPrice ? tickToProb(BigInt(state.lastPrice)) : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : last;

  const cellKey = makeCellKey({ underlying: UNDERLYING, endTs: cell.endTs, strikeE8: cell.strikeE8 });

  return (
    <aside className="flex h-full flex-col border-l hairline bg-[var(--color-surface)]">
      <header className="border-b hairline px-3 py-3">
        <p className="mb-2 text-[12px] leading-snug text-[var(--color-ink)]">
          {t("cell.above", {
            strike: `$${e8ToUsd(cell.strikeE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
            time: new Date(cell.endTs * 1000).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
        </p>

        <div className="grid grid-cols-4 gap-2">
          <Stat
            label={t("cell.timeLeft")}
            value={settled ? t("cell.expired") : formatClock(remaining)}
            colour={!settled && remaining < 60 ? "var(--color-live)" : undefined}
          />
          <Stat label={t("cell.mid")} value={mid === null ? "—" : mid.toFixed(3)} />
          <Stat
            label={t("cell.volume")}
            value={
              state ? sizeToContracts(BigInt(state.volume)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0"
            }
          />
          <Stat label={t("cell.makers")} value={String(state?.makers ?? 0)} />
        </div>

        {/* The payoff, stated once, in the units the ticket uses. */}
        {!settled && mid !== null && (
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            1 × {side.toUpperCase()} @ {mid.toFixed(3)} → 1.00 {t("ticket.maxPayout").toLowerCase()} ·{" "}
            {(1 / Math.max(mid, 0.001)).toFixed(2)}×
          </p>
        )}

        <div className="mt-3 flex overflow-hidden rounded border hairline">
          {(["yes", "no"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSide(option)}
              className="flex-1 py-1 text-[11px]"
              style={
                side === option
                  ? {
                      background: option === "yes" ? "var(--color-yes-dim)" : "var(--color-no-dim)",
                      color: option === "yes" ? "var(--color-yes)" : "var(--color-no)",
                    }
                  : { color: "var(--color-ink-faint)" }
              }
            >
              {option.toUpperCase()}
            </button>
          ))}
        </div>

        {market && (
          <a
            href={`${chain.explorerUrl}/address/${market}`}
            target="_blank"
            rel="noreferrer"
            className="num mt-2 block text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]"
          >
            Kuru {market.slice(0, 10)}…{market.slice(-6)}
          </a>
        )}
      </header>

      <nav className="flex border-b hairline">
        {(["book", "tape", "flow", "notes"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className="flex-1 py-1.5 text-[11px]"
            style={{
              color: tab === option ? "var(--color-ink)" : "var(--color-ink-faint)",
              borderBottom: tab === option ? "1px solid var(--color-accent)" : "1px solid transparent",
            }}
          >
            {t(`cell.${option}` as const)}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-3 text-[11px] text-[var(--color-no)]">
            {t("status.indexer")}: {error.message}
          </p>
        )}

        {tab === "book" && (
          <>
            <OrderBook
              bids={data?.bids ?? []}
              asks={data?.asks ?? []}
              onPickPrice={(probability) => setPickedPrice(probability)}
            />
            <div className="border-t hairline">
              <p className="label px-3 pt-2">{t("cell.makers")}</p>
              <Makers makers={data?.liveMakers ?? []} />
            </div>
          </>
        )}

        {tab === "tape" && <Tape fills={data?.fills ?? []} />}
        {tab === "flow" && <FlowChart flow={data?.flow ?? []} />}
        {tab === "notes" && <Notes cellKey={cellKey} />}
      </div>

      <div className="border-t hairline">
        <OrderTicket
          market={market}
          side={side}
          windowId={cell.windowId}
          outcome={cell.outcome}
          suggestedPrice={pickedPrice}
          onRequireRisk={onRequireRisk}
        />
      </div>
    </aside>
  );
}

function Stat({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      <span className="num text-[12px]" style={{ color: colour ?? "var(--color-ink)" }}>
        {value}
      </span>
    </div>
  );
}
