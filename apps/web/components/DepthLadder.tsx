"use client";

import { useI18n } from "@/lib/i18n";
import type { RawLevel } from "@/lib/indexer";
import { formatCents, sizeToContracts, tickToCents } from "@pit/core";

type Props = {
  bids: RawLevel[];
  asks: RawLevel[];
  onPickCents: (cents: number) => void;
};

/**
 * The book, as a price ladder.
 *
 * Straight off the indexer's BookLevel rows: offers descend to the spread, bids
 * fall away from it, and the tightest prices meet in the middle — the shape
 * every trader already knows how to read. Prices are whole cents, because that
 * is what a binary costs.
 *
 * `orders` is here for a reason that matters on a five-minute market: 400
 * contracts from one maker and 400 from eight are the same depth and completely
 * different risk. It is also the column no payout tile can print.
 */
export function DepthLadder({ bids, asks, onPickCents }: Props) {
  const { t } = useI18n();

  const maxSize = Math.max(
    1,
    ...bids.map((level) => Number(level.size)),
    ...asks.map((level) => Number(level.size)),
  );

  const bestBid = bids[0] ? tickToCents(BigInt(bids[0].price)) : null;
  const bestAsk = asks[0] ? tickToCents(BigInt(asks[0].price)) : null;
  const width = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

  if (bids.length === 0 && asks.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="mb-1 text-[12px] text-[var(--color-foam-dim)]">{t("cell.noBook")}</p>
        <p className="label leading-relaxed">{t("cell.noBookHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b rule px-4 py-1">
        <span className="label">{t("cell.price")}</span>
        <span className="label text-right">{t("cell.size")}</span>
        <span className="label text-right">{t("cell.orders")}</span>
      </div>

      {/* Offers, worst at the top, so the best one sits against the spread. */}
      <div className="flex flex-col-reverse">
        {asks.map((level) => (
          <Row key={`a${level.price}`} level={level} maxSize={maxSize} side="ask" onPick={onPickCents} />
        ))}
      </div>

      <div className="flex items-baseline justify-between border-y rule bg-[var(--color-raised)] px-4 py-1.5">
        <span className="readout text-[13px] font-semibold">
          {mid === null ? "—" : formatCents(mid)}
        </span>
        <span className="data text-[10px] text-[var(--color-foam-faint)]">
          <span className="label mr-1.5">{t("cell.width")}</span>
          {width === null ? "—" : `${width}¢`}
        </span>
      </div>

      <div className="flex flex-col">
        {bids.map((level) => (
          <Row key={`b${level.price}`} level={level} maxSize={maxSize} side="bid" onPick={onPickCents} />
        ))}
      </div>
    </div>
  );
}

function Row({
  level,
  maxSize,
  side,
  onPick,
}: {
  level: RawLevel;
  maxSize: number;
  side: "bid" | "ask";
  onPick: (cents: number) => void;
}) {
  const { t } = useI18n();
  const cents = tickToCents(BigInt(level.price));
  const colour = side === "bid" ? "var(--color-yes)" : "var(--color-no)";

  return (
    <button
      type="button"
      onClick={() => onPick(cents)}
      title={t("cell.usePrice")}
      className="relative grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-[3px] text-left transition-colors hover:bg-[var(--color-raised)]"
    >
      <span
        aria-hidden
        className="depth"
        style={{ width: `${Math.max(2, (Number(level.size) / maxSize) * 100)}%`, background: colour }}
      />
      <span className="data text-[11.5px] font-medium" style={{ color: colour }}>
        {formatCents(cents)}
      </span>
      <span className="data text-right text-[11.5px] text-[var(--color-foam-dim)]">
        {Math.round(sizeToContracts(BigInt(level.size))).toLocaleString()}
      </span>
      <span className="data w-6 text-right text-[11.5px] text-[var(--color-foam-faint)]">
        {level.orderCount}
      </span>
    </button>
  );
}
