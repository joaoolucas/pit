"use client";

import { useI18n } from "@/lib/i18n";
import type { RawLevel } from "@/lib/indexer";
import { sizeToContracts, tickToProb } from "@cell/core";

type Props = {
  bids: RawLevel[];
  asks: RawLevel[];
  onPickPrice: (probability: number) => void;
};

/**
 * The L2 book, straight off the indexer's BookLevel rows.
 *
 * Asks descend to the spread and bids fall away from it, so the tightest prices
 * meet in the middle — the shape every trader already knows how to read. Depth
 * bars are scaled to the largest level on screen, and `orderCount` is shown
 * because on a five-minute market it matters whether 400 contracts is one maker
 * or eight.
 */
export function OrderBook({ bids, asks, onPickPrice }: Props) {
  const { t } = useI18n();

  const maxSize = Math.max(
    1,
    ...bids.map((level) => Number(level.size)),
    ...asks.map((level) => Number(level.size)),
  );

  const bestBid = bids[0] ? tickToProb(BigInt(bids[0].price)) : null;
  const bestAsk = asks[0] ? tickToProb(BigInt(asks[0].price)) : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-3 border-b hairline px-3 py-1">
        <span className="label">{t("cell.price")}</span>
        <span className="label text-right">{t("cell.size")}</span>
        <span className="label text-right">{t("cell.orders")}</span>
      </div>

      {/* Asks, worst at the top, so the best offer sits against the spread. */}
      <div className="flex flex-col-reverse">
        {asks.map((level) => (
          <Row
            key={`a${level.price}`}
            level={level}
            maxSize={maxSize}
            side="ask"
            onPickPrice={onPickPrice}
          />
        ))}
      </div>

      <div className="flex items-baseline justify-between border-y hairline bg-[var(--color-raised)] px-3 py-1.5">
        <span className="num text-[12px] text-[var(--color-ink)]">
          {mid === null ? "—" : mid.toFixed(3)}
        </span>
        <span className="text-[10px] text-[var(--color-ink-faint)]">
          <span className="label mr-1">{t("cell.spread")}</span>
          <span className="num">{spread === null ? "—" : spread.toFixed(3)}</span>
        </span>
      </div>

      <div className="flex flex-col">
        {bids.map((level) => (
          <Row
            key={`b${level.price}`}
            level={level}
            maxSize={maxSize}
            side="bid"
            onPickPrice={onPickPrice}
          />
        ))}
      </div>

      {bids.length === 0 && asks.length === 0 && (
        <p className="px-3 py-6 text-center text-[11px] text-[var(--color-ink-faint)]">
          {t("cell.noMakers")}
        </p>
      )}
    </div>
  );
}

function Row({
  level,
  maxSize,
  side,
  onPickPrice,
}: {
  level: RawLevel;
  maxSize: number;
  side: "bid" | "ask";
  onPickPrice: (probability: number) => void;
}) {
  const probability = tickToProb(BigInt(level.price));
  const width = `${Math.max(2, (Number(level.size) / maxSize) * 100)}%`;
  const colour = side === "bid" ? "var(--color-yes)" : "var(--color-no)";

  return (
    <button
      type="button"
      onClick={() => onPickPrice(probability)}
      className="relative grid grid-cols-3 px-3 py-[3px] text-left hover:bg-[var(--color-raised)]"
      title="Use this price in the ticket"
    >
      {/* Depth grows from the price column outward, so the numbers stay legible. */}
      <span
        className="depth-bar left-0 rounded-r-sm"
        style={{ width, background: colour }}
        aria-hidden
      />
      <span className="num text-[11px]" style={{ color: colour }}>
        {probability.toFixed(3)}
      </span>
      <span className="num text-right text-[11px] text-[var(--color-ink-dim)]">
        {sizeToContracts(BigInt(level.size)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
      <span className="num text-right text-[11px] text-[var(--color-ink-faint)]">
        {level.orderCount}
      </span>
    </button>
  );
}
