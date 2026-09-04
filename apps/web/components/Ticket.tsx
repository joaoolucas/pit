"use client";

import { ethers } from "ethers";
import { useEffect, useMemo, useState } from "react";

import { CELL_POLL_MS } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { MY_ORDERS_QUERY, usePolledQuery, type RawOrder } from "@/lib/indexer";
import { UNDERLYING } from "@/lib/config";
import { cancelOrders, ensureWindow, mintSet, placeLimit, redeem } from "@/lib/kuru";
import { formatUnits, useCollateral } from "@/lib/useCollateral";
import { useWallet } from "@/lib/wallet";
import {
  centsToTick,
  formatCents,
  Outcome,
  priceTicket,
  sizeToContracts,
  tickToCents,
  WINDOW_SECONDS,
  type Side,
} from "@pit/core";

/** Dollar amounts a tap away. Enough to size a trade without typing. */
const CHIPS = [5, 25, 100] as const;

export type LegQuote = {
  side: Side;
  market: string;
  /** Cheapest offer, in cents. Null when nobody is selling. */
  askCents: number | null;
  /** Best bid, in cents. Null when nobody is buying. */
  bidCents: number | null;
};

type Props = {
  windowId: number;
  outcome: Outcome;
  legs: Record<Side, LegQuote | null>;
  /** Unlisted cell: first order deploys the two Kuru books. */
  list?: { endTs: number; strikeE8: bigint } | null;
  /** Set when a price is clicked in the book, so Make can join or lift it. */
  pickedCents: number | null;
  onRequireRisk: () => Promise<boolean>;
  /**
   * The two-tap path on its own: pick a side, tap an amount, send.
   *
   * Make is a price and a size, and open orders are a thing you go and look at.
   * Neither is what someone who just clicked a tile is doing, and both were on
   * screen before the amount was. They live in the opened cell instead.
   */
  compact?: boolean;
};

type Mode = "take" | "make";
type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

/**
 * The ticket.
 *
 * Split by who is using it, because takers and makers do not think in the same
 * units. **Take** is dollars in, dollars back — the two-tap path a tape trader
 * wants: pick a side, tap an amount, send. **Make** is a price and a size, which
 * is what someone posting a quote actually decides, and it is the half no payout
 * tile can offer: on Pit you can be the one collecting the spread.
 *
 * Every order leaves through the Kuru SDK. Nothing in this file records a trade
 * anywhere but on the book.
 */
export function Ticket({
  windowId,
  outcome,
  legs,
  list = null,
  pickedCents,
  onRequireRisk,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const wallet = useWallet();
  const collateral = useCollateral(wallet.address);

  const [chosen, setMode] = useState<Mode>("take");
  const mode: Mode = compact ? "take" : chosen;
  const [side, setSide] = useState<Side>("yes");
  const [dollars, setDollars] = useState("25");
  const [makeCents, setMakeCents] = useState("50");
  const [makeSize, setMakeSize] = useState("200");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [opened, setOpened] = useState<{
    windowId: number;
    yesMarket: string;
    noMarket: string;
  } | null>(null);

  const liveWindowId = opened?.windowId ?? windowId;
  const liveMarket =
    (side === "yes" ? opened?.yesMarket : opened?.noMarket) || legs[side]?.market || "";
  const leg = liveMarket ? { ...legs[side], market: liveMarket, side } : legs[side];
  const settled = outcome !== Outcome.Unresolved;

  // Clicking a level in the book is the fastest way to join it or lift it.
  useEffect(() => {
    if (pickedCents === null) return;
    setMode("make");
    setMakeCents(String(Math.round(pickedCents)));
  }, [pickedCents]);

  const { data: orderData, refresh } = usePolledQuery<{ Order: RawOrder[] }>(
    MY_ORDERS_QUERY,
    { owner: wallet.address?.toLowerCase() ?? "", market: leg?.market.toLowerCase() ?? "" },
    CELL_POLL_MS * 3,
    Boolean(wallet.address && leg),
  );
  const myOrders = orderData?.Order ?? [];

  const takeTicket = useMemo(
    () => (leg?.askCents == null ? null : priceTicket(Number(dollars), leg.askCents)),
    [dollars, leg?.askCents],
  );

  const makeNumbers = useMemo(() => {
    const cents = Number(makeCents);
    const size = Number(makeSize);
    if (!Number.isFinite(cents) || !Number.isFinite(size)) return null;
    if (cents <= 0 || cents >= 100 || size <= 0) return null;
    return { cents, size, locks: (cents / 100) * size, pays: size };
  }, [makeCents, makeSize]);

  /* ----------------------------------------------------------------- actions */

  const guard = async (label: string) => {
    // The ticket fills in without a wallet, so every action can be reached
    // without one. Asking for it here is the only place it is actually needed.
    if (!wallet.address) {
      void wallet.connect();
      return false;
    }
    if (!(await onRequireRisk())) return false;
    setStatus({ kind: "busy", label });
    return true;
  };

  const openIfNeeded = async (signer: ethers.Signer) => {
    if (liveMarket) return { market: liveMarket, windowId: liveWindowId };
    if (!list) throw new Error("no market");
    setStatus({ kind: "busy", label: t("ticket.listing") });
    const listed = await ensureWindow(signer, {
      underlying: UNDERLYING,
      startTs: list.endTs - WINDOW_SECONDS,
      endTs: list.endTs,
      strikeE8: list.strikeE8,
    });
    setOpened({
      windowId: listed.windowId,
      yesMarket: listed.yesMarket,
      noMarket: listed.noMarket,
    });
    return {
      market: side === "yes" ? listed.yesMarket : listed.noMarket,
      windowId: listed.windowId,
    };
  };

  const take = async () => {
    if (!leg || leg.askCents == null || !takeTicket) return;
    if (!(await guard(t("ticket.sending")))) return;
    try {
      const signer = wallet.getSigner();
      const { market } = await openIfNeeded(signer);
      await placeLimit(signer, {
        market,
        // Cross the offer. Anything not filled rests at the same price, which is
        // the honest outcome of a limit that reached the far side.
        price: (leg.askCents / 100).toFixed(3),
        size: String(takeTicket.contracts),
        isBuy: true,
        postOnly: false,
      });
      setStatus({
        kind: "ok",
        message: t("ticket.bought", {
          contracts: takeTicket.contracts,
          side: side.toUpperCase(),
          price: formatCents(leg.askCents),
        }),
      });
      refresh();
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const post = async (isBuy: boolean) => {
    if (!makeNumbers) return;
    if (!(await guard(t("ticket.posting")))) return;
    try {
      const signer = wallet.getSigner();
      const { market } = await openIfNeeded(signer);
      await placeLimit(signer, {
        market,
        price: (makeNumbers.cents / 100).toFixed(3),
        size: String(makeNumbers.size),
        isBuy,
        postOnly: true,
      });
      setStatus({
        kind: "ok",
        message: t("ticket.posted", {
          size: makeNumbers.size,
          side: side.toUpperCase(),
          price: formatCents(makeNumbers.cents),
        }),
      });
      refresh();
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const cancelAll = async () => {
    if (!liveMarket || myOrders.length === 0) return;
    setStatus({ kind: "busy", label: t("ticket.cancelling") });
    try {
      await cancelOrders(
        wallet.getSigner(),
        liveMarket,
        myOrders.map((order) => order.orderId),
      );
      setStatus({ kind: "ok", message: t("ticket.cancelled") });
      refresh();
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const mint = async () => {
    if (!makeNumbers) return;
    if (!(await guard(t("ticket.minting")))) return;
    try {
      const amount = ethers.utils.parseUnits(String(makeNumbers.size), collateral.decimals);
      const signer = wallet.getSigner();
      const openedWindow = await openIfNeeded(signer);
      await mintSet(signer, openedWindow.windowId, amount);
      setStatus({ kind: "ok", message: t("ticket.minted", { size: makeNumbers.size }) });
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  const claim = async () => {
    setStatus({ kind: "busy", label: t("ticket.redeeming") });
    try {
      await redeem(wallet.getSigner(), liveWindowId);
      setStatus({ kind: "ok", message: t("ticket.redeemed") });
    } catch (error) {
      setStatus({ kind: "error", message: cleanRevert(error) });
    }
  };

  /* ------------------------------------------------------------------ views */

  /**
   * No wallet is not a reason to hide the prices.
   *
   * This used to replace the whole ticket with a Connect button, which meant the
   * quickest thing about the quick ticket — two prices, an amount, what it pays
   * — was behind a wallet connection. Nothing here reads a chain to work out any
   * of that; the book comes from the indexer and the arithmetic is local. So the
   * ticket fills in either way and the last step is the one that needs a signer.
   */
  const anonymous = !wallet.address;
  const connect = () => void wallet.connect();

  if (settled) {
    return (
      <div className="px-4 py-5 text-center">
        <p className="mb-1 label">
          {outcome === Outcome.Yes
            ? t("cell.outcome.yes")
            : outcome === Outcome.No
              ? t("cell.outcome.no")
              : t("cell.outcome.void")}
        </p>
        <p className="mb-4 text-[12px] text-[var(--color-foam-dim)]">{t("ticket.redeemBlurb")}</p>
        <button
          type="button"
          onClick={anonymous ? connect : () => void claim()}
          className="btn-primary w-full"
        >
          {anonymous ? t("wallet.connect") : t("ticket.redeem")}
        </button>
        <StatusLine status={status} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {!compact && (
        <div className="mx-3 mt-3 flex gap-1 rounded-full bg-[var(--color-deep)] p-1">
          {(["take", "make"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className="flex-1 rounded-full py-1.5 text-[11px] font-extrabold uppercase tracking-[0.1em]"
              style={{
                color: mode === option ? "var(--color-deep)" : "var(--color-foam-faint)",
                background: mode === option ? "var(--color-foam)" : "transparent",
              }}
            >
              {t(`ticket.${option}` as const)}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 px-4 py-3">
        {/* Side, with the price on the button — the only two prices that matter
            when taking, side by side, adding to about 100. */}
        <div className="grid grid-cols-2 gap-2">
          {(["yes", "no"] as const).map((option) => {
            const quote = legs[option];
            const active = side === option;
            const price = mode === "take" ? quote?.askCents : quote?.bidCents;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setSide(option)}
                className="flex flex-col items-center gap-0.5 rounded-[22px] border-2 py-2.5 transition-colors"
                style={{
                  borderColor: active ? `var(--color-${option})` : "var(--color-rule)",
                  background: active
                    ? `color-mix(in oklab, var(--color-${option}) 14%, transparent)`
                    : "transparent",
                  color: active ? `var(--color-${option})` : "var(--color-foam-dim)",
                }}
              >
                <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
                  {t(`ticket.${option}` as const)}
                </span>
                <span className="readout text-[20px] leading-none">
                  {price == null ? "—" : formatCents(price)}
                </span>
              </button>
            );
          })}
        </div>

        {mode === "take" ? (
          <>
            <div className="flex items-stretch gap-2">
              <label className="flex flex-1 items-center rounded-full border-2 rule bg-[var(--color-deep)] px-3">
                <span className="data mr-1 text-[13px] text-[var(--color-foam-faint)]">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={1}
                  value={dollars}
                  onChange={(event) => setDollars(event.target.value)}
                  aria-label={t("ticket.amount")}
                  className="readout w-full bg-transparent py-2 text-[18px] outline-none"
                />
              </label>
              {CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setDollars(String((Number(dollars) || 0) + chip))}
                  className="chip data px-2.5 text-[12px] font-bold text-[var(--color-foam-dim)] transition-colors hover:border-[var(--color-rule-bright)] hover:text-[var(--color-foam)]"
                >
                  +{chip}
                </button>
              ))}
            </div>

            {/* The number that decides it. */}
            <div className="rounded-[24px] bg-[var(--color-raised)] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,244,232,0.12)]">
              <div className="flex items-end justify-between">
                <span className="label">{t("ticket.toWin")}</span>
                <span
                  className="readout text-[36px] leading-none"
                  style={{ color: takeTicket ? "var(--color-yes)" : "var(--color-foam-faint)" }}
                >
                  {takeTicket ? `$${takeTicket.toWin.toFixed(2)}` : "—"}
                </span>
              </div>
              <p className="data mt-1.5 text-[10px] text-[var(--color-foam-faint)]">
                {takeTicket && leg?.askCents != null
                  ? t("ticket.takeDetail", {
                      contracts: takeTicket.contracts,
                      price: formatCents(leg.askCents),
                      spend: takeTicket.spend.toFixed(2),
                      multiple: `${takeTicket.multiple.toFixed(2)}x`,
                    })
                  : leg?.askCents == null
                    ? t("ticket.noOffer")
                    : t("ticket.tooSmall")}
              </p>
            </div>

            <button
              type="button"
              onClick={anonymous ? connect : () => void take()}
              disabled={
                !anonymous && (!takeTicket || status.kind === "busy" || !wallet.onRightChain)
              }
              className="btn-primary w-full"
              style={anonymous ? undefined : { background: `var(--color-${side})` }}
            >
              {anonymous
                ? t("wallet.connect")
                : status.kind === "busy"
                  ? status.label
                  : leg?.askCents == null
                    ? t("ticket.noOffer")
                    : t("ticket.buyAction", {
                        side: t(`ticket.${side}` as const),
                        price: formatCents(leg.askCents),
                      })}
            </button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t("ticket.price")}
                value={makeCents}
                onChange={setMakeCents}
                suffix="¢"
                step={1}
              />
              <Field
                label={t("ticket.size")}
                value={makeSize}
                onChange={setMakeSize}
                suffix=""
                step={10}
              />
            </div>

            <p className="data text-[10px] leading-relaxed text-[var(--color-foam-faint)]">
              {makeNumbers
                ? t("ticket.makeDetail", {
                    locks: makeNumbers.locks.toFixed(2),
                    pays: makeNumbers.pays.toFixed(2),
                    symbol: collateral.symbol,
                  })
                : t("ticket.makeInvalid")}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void post(true)}
                disabled={!makeNumbers || status.kind === "busy"}
                className="btn-outline"
                style={{ color: "var(--color-yes)", borderColor: "var(--color-yes-deep)" }}
              >
                {t("ticket.postBid")}
              </button>
              <button
                type="button"
                onClick={() => void post(false)}
                disabled={!makeNumbers || status.kind === "busy"}
                className="btn-outline"
                style={{ color: "var(--color-no)", borderColor: "var(--color-no-deep)" }}
              >
                {t("ticket.postAsk")}
              </button>
            </div>

            <div className="rounded-[22px] border-2 rule px-3 py-2.5">
              <p className="mb-2 text-[10px] leading-relaxed text-[var(--color-foam-faint)]">
                {t("ticket.needInventory")}
              </p>
              <button type="button" onClick={() => void mint()} className="btn-outline w-full">
                {t("ticket.mint", { size: makeSize, symbol: collateral.symbol })}
              </button>
            </div>
          </>
        )}

        <StatusLine status={status} />

        <div className={`border-t rule pt-2.5 ${compact ? "hidden" : ""}`}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="label">{t("ticket.myOrders")}</span>
            {myOrders.length > 0 && (
              <button
                type="button"
                onClick={() => void cancelAll()}
                className="text-[10px] text-[var(--color-no)] hover:underline"
              >
                {t("ticket.cancelAll")}
              </button>
            )}
          </div>
          {myOrders.length === 0 ? (
            <p className="text-[11px] text-[var(--color-foam-faint)]">{t("ticket.noOrders")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {myOrders.map((order) => (
                <div key={order.id} className="data flex items-baseline justify-between text-[11px]">
                  <span style={{ color: order.isBuy ? "var(--color-yes)" : "var(--color-no)" }}>
                    {order.isBuy ? t("ticket.bid") : t("ticket.ask")}{" "}
                    {formatCents(tickToCents(BigInt(order.price)))}
                  </span>
                  <span className="text-[var(--color-foam-faint)]">
                    {Math.round(sizeToContracts(BigInt(order.remainingSize)))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {collateral.symbol && (
          <p className="data text-[10px] text-[var(--color-foam-faint)]">
            {formatUnits(collateral.balance, collateral.decimals)} {collateral.symbol}
          </p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Field({
  label,
  value,
  onChange,
  suffix,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix: string;
  step: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className="flex items-center rounded-full border-2 rule bg-[var(--color-deep)] px-3">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="readout w-full bg-transparent py-1.5 text-[13px] outline-none"
        />
        {suffix && <span className="data text-[11px] text-[var(--color-foam-faint)]">{suffix}</span>}
      </span>
    </label>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "idle" || status.kind === "busy") return null;
  return (
    <p
      className="text-[11px] leading-relaxed"
      style={{
        color: status.kind === "ok" ? "var(--color-yes)" : "var(--color-no)",
      }}
    >
      {status.message}
    </p>
  );
}

/**
 * Wallet errors are a wall of JSON with the useful sentence buried in it. Dig
 * out the revert reason, because "PostOnlyCrossed" tells someone what to change
 * and "cannot estimate gas; transaction may fail" does not.
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
