"use client";

import { chain } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import type { RawFill, RawFlow } from "@/lib/indexer";
import { formatCents, shortAddress, sizeToContracts, tickToCents } from "@cell/core";

/**
 * The tape.
 *
 * Colour is taker aggression, not price direction: green when someone lifted the
 * offer, red when someone hit the bid. That is the read a tape trader wants, and
 * it is exactly what Kuru's Trade event tells us via the maker's side.
 */
export function Tape({ fills }: { fills: RawFill[] }) {
  const { t } = useI18n();

  if (fills.length === 0) {
    return <p className="px-3 py-6 text-center text-[11px] text-[var(--color-foam-faint)]">{t("cell.noFills")}</p>;
  }

  return (
    <div className="flex flex-col">
      {fills.map((fill) => {
        // makerIsBuy: the resting order was a bid, so the taker sold into it.
        const takerBought = !fill.makerIsBuy;
        const colour = takerBought ? "var(--color-yes)" : "var(--color-no)";
        return (
          <a
            key={fill.id}
            href={`${chain.explorerUrl}/tx/${fill.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-3 px-3 py-[3px] hover:bg-[var(--color-raised)]"
          >
            <span className="data text-[10px] text-[var(--color-foam-faint)]">
              {new Date(Number(fill.timestamp) * 1000).toLocaleTimeString(undefined, {
                hour12: false,
              })}
            </span>
            <span className="data text-[11px]" style={{ color: colour }}>
              {formatCents(tickToCents(BigInt(fill.price)))}
            </span>
            <span className="data text-[11px] text-[var(--color-foam-dim)]">
              {sizeToContracts(BigInt(fill.filledSize)).toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
            <span className="data text-[10px] text-[var(--color-foam-faint)]">
              {shortAddress(takerBought ? fill.taker : fill.maker, 3)}
            </span>
          </a>
        );
      })}
    </div>
  );
}

/**
 * Cumulative volume delta over the window's life.
 *
 * On a five-minute binary this is the single most useful derived series: it says
 * whether the price moved because someone paid up, or because a quote was pulled.
 * A cell can drift from 0.50 to 0.62 on a flat CVD, and that is worth seeing.
 */
export function FlowChart({ flow }: { flow: RawFlow[] }) {
  const { t } = useI18n();

  if (flow.length < 2) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-[var(--color-foam-faint)]">{t("cell.noFills")}</p>
    );
  }

  const values = flow.map((point) => Number(point.cvd));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, -1);
  const span = max - min || 1;

  const width = 100;
  const height = 40;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const zeroY = height - ((0 - min) / span) * height;
  const last = values[values.length - 1] ?? 0;
  const colour = last >= 0 ? "var(--color-yes)" : "var(--color-no)";

  return (
    <div className="px-3 py-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label">{t("cell.cvd")}</span>
        <span className="data text-[11px]" style={{ color: colour }}>
          {last > 0 ? "+" : ""}
          {sizeToContracts(BigInt(Math.trunc(last))).toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-16 w-full">
        <line
          x1={0}
          x2={width}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--color-rule-bright)"
          strokeWidth={0.4}
        />
        <polyline
          points={points}
          fill="none"
          stroke={colour}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

/** Who is quoting right now, biggest first. */
export function Makers({ makers }: { makers: { owner: string; liveOrders: number; restingSize: string }[] }) {
  const { t } = useI18n();

  if (makers.length === 0) {
    return <p className="px-3 py-4 text-center text-[11px] text-[var(--color-foam-faint)]">{t("cell.noMakers")}</p>;
  }

  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      {makers.map((maker) => (
        <div key={maker.owner} className="flex items-baseline justify-between">
          <a
            href={`${chain.explorerUrl}/address/${maker.owner}`}
            target="_blank"
            rel="noreferrer"
            className="data text-[11px] text-[var(--color-foam-dim)] hover:text-[var(--color-foam)]"
          >
            {shortAddress(maker.owner)}
          </a>
          <span className="data text-[11px] text-[var(--color-foam-faint)]">
            {sizeToContracts(BigInt(maker.restingSize)).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
            <span className="ml-1 text-[9px]">×{maker.liveOrders}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
