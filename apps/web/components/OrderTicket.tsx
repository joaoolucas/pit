"use client";

import { BigNumber, ethers } from "ethers";
import { useEffect, useMemo, useState } from "react";

import { CELL_POLL_MS } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { MY_ORDERS_QUERY, usePolledQuery, type RawOrder } from "@/lib/indexer";
import { cancelOrders, mintSet, placeLimit, redeem } from "@/lib/kuru";
import { formatUnits, useCollateral } from "@/lib/useCollateral";
import { useWallet } from "@/lib/wallet";
import { Outcome, payoff, sizeToContracts, tickToProb, type Side } from "@cell/core";

type Props = {
  market: string;
  side: Side;
  windowId: number;
  outcome: Outcome;
  suggestedPrice: number | null;
  onRequireRisk: () => Promise<boolean>;
};

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "ok"; hash?: string } | { kind: "error"; message: string };

/**
 * The ticket.
 *
 * Two numbers decide whether someone trades: what it costs and what it pays.
 * Both are shown before the button, in the collateral's own symbol, and the
 * payoff line is the plain sentence — buy 100 at 0.42, risk $42, make $58.
 *
 * Every order leaves here through the Kuru SDK. There is no path in this file
 * that records a trade anywhere but on the book.
 */
export function OrderTicket({ market, side, windowId, outcome, suggestedPrice, onRequireRisk }: Props) {
  const { t } = useI18n();
  const wallet = useWallet();
  const collateral = useCollateral(wallet.address);

  const [isBuy, setIsBuy] = useState(true);
  const [price, setPrice] = useState("0.500");
  const [size, setSize] = useState("100");
  const [postOnly, setPostOnly] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Clicking a level in the book fills the price in — the fastest way to join or
  // lift what is already there.
  useEffect(() => {
    if (suggestedPrice !== null) setPrice(suggestedPrice.toFixed(3));
  }, [suggestedPrice]);

  const settled = outcome !== Outcome.Unresolved;

  const { data: orderData, refresh } = usePolledQuery<{ Order: RawOrder[] }>(
    MY_ORDERS_QUERY,
    { owner: wallet.address?.toLowerCase() ?? "", market: market.toLowerCase() },
    CELL_POLL_MS * 3,
    Boolean(wallet.address),
  );
  const myOrders = orderData?.Order ?? [];

  // The three numbers a trader checks before pressing the button. Buying and
  // selling a binary are not mirror images, so the arithmetic lives in
  // @cell/core next to its tests rather than inline in a form.
  const numbers = useMemo(() => {
    const quote = payoff(Number(price), Number(size), isBuy);
    return quote === null ? null : { ...quote, price: Number(price), size: Number(size) };
  }, [price, size, isBuy]);

  const submit = async () => {
    if (!numbers || !wallet.address) return;
    if (!(await onRequireRisk())) return;

    setStatus({ kind: "busy", label: t("ticket.placing") });
    try {
      const receipt = await placeLimit(wallet.getSigner(), {
        market,
        price: numbers.price.toFixed(3),
        size: numbers.size.toString(),
        isBuy,
        postOnly,
      });
      setStatus({ kind: "ok", hash: receipt?.transactionHash });
      refresh();
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const cancelAll = async () => {
    if (myOrders.length === 0) return;
    setStatus({ kind: "busy", label: t("ticket.cancel") });
    try {
      await cancelOrders(
        wallet.getSigner(),
        market,
        myOrders.map((order) => order.orderId),
      );
      setStatus({ kind: "ok" });
      refresh();
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const mint = async () => {
    if (!numbers || !wallet.address) return;
    setStatus({ kind: "busy", label: t("ticket.minting") });
    try {
      const amount = ethers.utils.parseUnits(numbers.size.toString(), collateral.decimals);
      await mintSet(wallet.getSigner(), windowId, amount);
      setStatus({ kind: "ok" });
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const claim = async () => {
    setStatus({ kind: "busy", label: t("ticket.redeem") });
    try {
      await redeem(wallet.getSigner(), windowId);
      setStatus({ kind: "ok" });
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  if (!wallet.address) {
    return (
      <div className="px-3 py-5 text-center">
        <p className="mb-3 text-[11px] text-[var(--color-ink-faint)]">{t("ticket.needWallet")}</p>
        <button
          type="button"
          onClick={() => void wallet.connect()}
          className="rounded border border-[var(--color-line-bright)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]"
        >
          {t("wallet.connect")}
        </button>
      </div>
    );
  }

  if (settled) {
    return (
      <div className="px-3 py-5 text-center">
        <p className="mb-3 text-[12px] text-[var(--color-ink-dim)]">
          {outcome === Outcome.Yes
            ? t("cell.outcome.yes")
            : outcome === Outcome.No
              ? t("cell.outcome.no")
              : t("cell.outcome.void")}
        </p>
        <button
          type="button"
          onClick={() => void claim()}
          className="rounded border border-[var(--color-yes)] px-4 py-1.5 text-[11px] text-[var(--color-yes)] hover:bg-[var(--color-yes-dim)]"
        >
          {t("ticket.redeem")}
        </button>
        <StatusLine status={status} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex overflow-hidden rounded border hairline">
        {[true, false].map((buy) => (
          <button
            key={String(buy)}
            type="button"
            onClick={() => setIsBuy(buy)}
            className="flex-1 py-1.5 text-[11px]"
            style={
              isBuy === buy
                ? {
                    background: buy ? "var(--color-yes-dim)" : "var(--color-no-dim)",
                    color: buy ? "var(--color-yes)" : "var(--color-no)",
                  }
                : { color: "var(--color-ink-faint)" }
            }
          >
            {buy ? t("ticket.buy") : t("ticket.sell")} {side.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label={t("ticket.limitPrice")} value={price} onChange={setPrice} step="0.001" suffix="" />
        <Field label={t("ticket.contracts")} value={size} onChange={setSize} step="1" suffix="" />
      </div>

      <label className="flex items-center gap-2 text-[11px] text-[var(--color-ink-dim)]">
        <input
          type="checkbox"
          checked={postOnly}
          onChange={(event) => setPostOnly(event.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        {t("ticket.postOnly")}
      </label>

      {/* The payoff, in words a person uses, and labelled for the side actually
          being traded — "max payout" means something different when you are the
          one writing the contract. */}
      <dl className="flex flex-col gap-1 rounded border hairline bg-[var(--color-raised)] px-2.5 py-2 text-[11px]">
        <Line
          label={isBuy ? t("ticket.cost") : t("ticket.maxLoss")}
          value={numbers ? `${numbers.risk.toFixed(2)} ${collateral.symbol}` : "—"}
          colour={isBuy ? undefined : "var(--color-no)"}
        />
        <Line
          label={isBuy ? t("ticket.maxPayout") : t("ticket.premium")}
          value={numbers ? `${numbers.proceeds.toFixed(2)} ${collateral.symbol}` : "—"}
        />
        <Line
          label={t("ticket.profit")}
          value={numbers ? `+${numbers.profit.toFixed(2)} ${collateral.symbol}` : "—"}
          colour="var(--color-yes)"
        />
      </dl>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!numbers || status.kind === "busy" || !wallet.onRightChain}
        className="rounded bg-[var(--color-accent)] py-2 text-[12px] font-medium text-[var(--color-void)] disabled:opacity-40"
      >
        {status.kind === "busy" ? status.label : t("ticket.place")}
      </button>

      {!isBuy && (
        <div className="rounded border hairline px-2.5 py-2">
          <p className="mb-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            {t("ticket.needInventory")}
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            className="w-full rounded border border-[var(--color-line-bright)] py-1.5 text-[11px] hover:border-[var(--color-accent)]"
          >
            {t("ticket.mint", { amount: `${size} ${collateral.symbol}` })}
          </button>
        </div>
      )}

      <StatusLine status={status} />

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="label">{t("ticket.myOrders")}</span>
          {myOrders.length > 0 && (
            <button
              type="button"
              onClick={() => void cancelAll()}
              className="text-[10px] text-[var(--color-no)] hover:underline"
            >
              {t("ticket.cancel")}
            </button>
          )}
        </div>
        {myOrders.length === 0 ? (
          <p className="text-[11px] text-[var(--color-ink-faint)]">{t("ticket.noOrders")}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {myOrders.map((order) => (
              <div key={order.id} className="flex items-baseline justify-between text-[11px]">
                <span
                  className="num"
                  style={{ color: order.isBuy ? "var(--color-yes)" : "var(--color-no)" }}
                >
                  {order.isBuy ? t("ticket.buy") : t("ticket.sell")} {tickToProb(BigInt(order.price)).toFixed(3)}
                </span>
                <span className="num text-[var(--color-ink-faint)]">
                  {sizeToContracts(BigInt(order.remainingSize)).toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-[var(--color-ink-faint)]">
        {collateral.symbol && (
          <>
            {formatUnits(collateral.balance, collateral.decimals)} {collateral.symbol}
          </>
        )}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step: string;
  suffix: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <div className="flex items-center rounded border hairline bg-[var(--color-void)] px-2">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="num w-full bg-transparent py-1.5 text-[12px] outline-none"
        />
        {suffix && <span className="text-[10px] text-[var(--color-ink-faint)]">{suffix}</span>}
      </div>
    </label>
  );
}

function Line({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="num" style={{ color: colour ?? "var(--color-ink)" }}>
        {value}
      </dd>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  const { t } = useI18n();
  if (status.kind === "idle" || status.kind === "busy") return null;

  if (status.kind === "ok") {
    return <p className="text-[11px] text-[var(--color-yes)]">{t("ticket.sent")}</p>;
  }
  return (
    <p className="break-words text-[11px] text-[var(--color-no)]">
      {t("ticket.failed")}: {status.message}
    </p>
  );
}

/**
 * Wallet errors are a wall of JSON with the useful sentence buried in it. Dig
 * out the revert reason, because "PostOnlyCrossed" is actionable and
 * "cannot estimate gas; transaction may fail or may require manual gas limit"
 * is not.
 */
function cleanRevert(error: unknown): string {
  const candidate = error as {
    reason?: string;
    shortMessage?: string;
    error?: { message?: string };
    data?: { message?: string };
    message?: string;
  };
  const raw =
    candidate.reason ??
    candidate.shortMessage ??
    candidate.error?.message ??
    candidate.data?.message ??
    candidate.message ??
    "Unknown error";
  const named = /reverted with custom error '([^']+)'|reverted: ([^"]+)/.exec(raw);
  return (named?.[1] ?? named?.[2] ?? raw).slice(0, 160);
}
