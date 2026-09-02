"use client";

import { useMemo, useState } from "react";

import { GRID_POLL_MS, UNDERLYING } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { GRID_QUERY, usePolledQuery, type RawCellState } from "@/lib/indexer";
import { useCandles, useNow, useSpot } from "@/lib/usePrice";
import { CellPanel } from "./CellPanel";
import { cellId, Grid, impliedProbability } from "./Grid";
import { Header } from "./Header";
import { RiskDialog, useRiskGate } from "./RiskGate";
import type { GridCell } from "./types";
import { Outcome, tickToProb, upcomingWindowEnds, WINDOW_SECONDS, type Side } from "@cell/core";

/** Settled columns kept on the board. They are the proof that settlement works. */
const PAST_COLUMNS = 2;
const FUTURE_COLUMNS = 6;

export function Terminal() {
  const { t } = useI18n();
  const now = useNow();
  const { priceE8 } = useSpot(UNDERLYING);
  const candles = useCandles(UNDERLYING);
  const risk = useRiskGate();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The visible span: a couple of settled columns, the live one, and the next
  // few. Recomputed from `now` but snapped to window boundaries, so it only
  // actually changes once every five minutes.
  const columns = useMemo(() => {
    const upcoming = upcomingWindowEnds(now, FUTURE_COLUMNS);
    const first = upcoming[0]!;
    const past = Array.from({ length: PAST_COLUMNS }, (_, i) => first - (PAST_COLUMNS - i) * WINDOW_SECONDS);
    return [...past, ...upcoming];
  }, [Math.floor(now / WINDOW_SECONDS)]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, error, loading, updatedAt } = usePolledQuery<{ CellState: RawCellState[] }>(
    GRID_QUERY,
    {
      endTsFrom: String(columns[0] ?? 0),
      endTsTo: String(columns[columns.length - 1] ?? 0),
      underlying: UNDERLYING,
    },
    GRID_POLL_MS,
  );

  // Two rows per window — the YES market and the NO market — folded into one
  // tile each, keyed by (endTs, strike).
  const { cells, strikes } = useMemo(() => {
    const byCell = new Map<string, GridCell>();
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

      const yes = legs.yes;
      const no = legs.no;
      const probability = impliedProbability(
        yes?.bestBid ? BigInt(yes.bestBid) : null,
        yes?.bestAsk ? BigInt(yes.bestAsk) : null,
        no?.bestBid ? BigInt(no.bestBid) : null,
        no?.bestAsk ? BigInt(no.bestAsk) : null,
        yes?.lastPrice ? BigInt(yes.lastPrice) : null,
      );

      const spread =
        yes?.bestBid && yes?.bestAsk
          ? (tickToProb(BigInt(yes.bestAsk)) - tickToProb(BigInt(yes.bestBid))) / 2
          : null;

      byCell.set(id, {
        id,
        windowId: Number(row.windowId),
        endTs,
        strikeE8,
        outcome: (row.outcome ?? 0) as Outcome,
        impliedProbability: probability,
        spread,
        makers: Math.max(existing?.makers ?? 0, yes?.makers ?? 0, no?.makers ?? 0),
        volume: (yes ? BigInt(yes.volume) : 0n) + (no ? BigInt(no.volume) : 0n),
        legs,
      });
    }

    return {
      cells: byCell,
      strikes: [...strikeSet.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)),
    };
  }, [data]);

  const selected = selectedId ? (cells.get(selectedId) ?? null) : null;
  const indexerAge = updatedAt === null ? null : (Date.now() - updatedAt) / 1000;

  return (
    <div className="flex h-dvh flex-col">
      <Header
        spotE8={priceE8}
        indexerAgeSeconds={indexerAge}
        indexerDown={Boolean(error)}
        onOpenRisk={risk.show}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_336px]">
        <section className="min-h-0 overflow-hidden">
          {error && !data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-[12px] text-[var(--color-no)]">
                {t("status.indexer")}: {t("status.down")}
              </p>
              <p className="max-w-sm text-[11px] text-[var(--color-ink-faint)]">{error.message}</p>
            </div>
          ) : loading && !data ? (
            <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-ink-faint)]">
              …
            </div>
          ) : (
            <Grid
              columns={columns}
              strikes={strikes}
              cells={cells}
              spotE8={priceE8}
              candles={candles}
              now={now}
              selectedId={selectedId}
              onSelect={(cell) => setSelectedId(cell.id)}
            />
          )}
        </section>

        {selected ? (
          <CellPanel cell={selected} now={now} onRequireRisk={risk.require} />
        ) : (
          <aside className="hidden items-center justify-center border-l hairline bg-[var(--color-surface)] p-8 text-center text-[12px] text-[var(--color-ink-faint)] lg:flex">
            {t("cell.select")}
          </aside>
        )}
      </main>

      <RiskDialog open={risk.open} onAccept={risk.accept} onDismiss={risk.dismiss} />
    </div>
  );
}
