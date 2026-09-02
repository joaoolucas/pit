"use client";

import { chain, isConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { useWallet } from "@/lib/wallet";
import { e8ToUsd, shortAddress } from "@pit/core";

type Props = {
  spotE8: bigint | null;
  /** Move over the window the trace covers, as a fraction. Null until known. */
  changePct: number | null;
  indexerAgeSeconds: number | null;
  indexerDown: boolean;
  onOpenRisk: () => void;
};

export function Header({ spotE8, changePct, indexerAgeSeconds, indexerDown, onOpenRisk }: Props) {
  const { t } = useI18n();

  return (
    <header className="shrink-0 px-2 pt-2">
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[20px] px-4 py-1.5 shadow-[0_5px_0_rgba(20,8,28,0.28)]">
        {/* The mark: three balloons and a fat word. */}
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex items-end gap-0.5">
            <span className="orb size-[11px] bg-[var(--color-yes)]" />
            <span className="orb size-[16px] bg-[var(--color-live)]" />
            <span className="orb size-[11px] bg-[var(--color-no)]" />
          </span>
          <span className="mark text-[24px] leading-none text-[var(--color-foam)]">Pit</span>
          <span className="hidden text-[12px] font-medium text-[var(--color-foam-faint)] xl:inline">
            {t("app.tagline")}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-4">
          {/* Spot anchors every strike on the board, so it goes first and never
              moves. */}
          <div className="flex items-baseline gap-2">
            <span className="label">BTC</span>
            <span className="readout text-[24px] leading-none">
              {spotE8 === null
                ? "—"
                : e8ToUsd(spotE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
            {changePct !== null && (
              <span
                className="readout text-[13px]"
                style={{
                  color: changePct >= 0 ? "var(--color-yes)" : "var(--color-no)",
                }}
              >
                {changePct >= 0 ? "+" : ""}
                {(changePct * 100).toFixed(2)}%
              </span>
            )}
          </div>

          <IndexerPill ageSeconds={indexerAgeSeconds} down={indexerDown} />

          <button
            type="button"
            onClick={onOpenRisk}
            className="text-[12px] font-bold text-[var(--color-foam-dim)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--color-foam)]"
          >
            {t("risk.more")}
          </button>

          <WalletButton />
        </div>
      </div>

      {!isConfigured && (
        <p className="mx-1 mt-2 rounded-full bg-[color-mix(in_oklab,var(--color-no)_16%,transparent)] px-4 py-1.5 text-[12px] text-[var(--color-foam-dim)]">
          {t("status.notConfigured")}
        </p>
      )}
    </header>
  );
}

function IndexerPill({ ageSeconds, down }: { ageSeconds: number | null; down: boolean }) {
  const { t } = useI18n();

  // Three states, and the middle one is the point: a book ten seconds behind on
  // a five-minute market is a book you should not lift.
  const waiting = !down && ageSeconds === null;
  const stale = !down && ageSeconds !== null && ageSeconds > 5;

  const colour = down
    ? "var(--color-no)"
    : waiting
      ? "var(--color-foam-faint)"
      : stale
        ? "var(--color-live)"
        : "var(--color-yes)";

  const text = down
    ? t("status.down")
    : waiting
      ? "…"
      : stale
        ? t("status.stale", { seconds: Math.round(ageSeconds ?? 0) })
        : t("status.live");

  return (
    <div className="chip flex items-center gap-1.5 px-2.5 py-1" title={t("status.indexer")}>
      <span aria-hidden className="orb inline-block size-2" style={{ background: colour }} />
      <span className="text-[11px] font-bold text-[var(--color-foam-dim)]">
        <span className="label mr-1">{t("status.indexer")}</span>
        {text}
      </span>
    </div>
  );
}

function WalletButton() {
  const { t } = useI18n();
  const wallet = useWallet();

  if (!wallet.available) {
    return <span className="text-[11px] text-[var(--color-foam-faint)]">{t("wallet.none")}</span>;
  }

  if (!wallet.address) {
    return (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={wallet.connecting}
        className="btn-outline"
      >
        {wallet.connecting ? t("wallet.connecting") : t("wallet.connect")}
      </button>
    );
  }

  if (!wallet.onRightChain) {
    return (
      <button
        type="button"
        onClick={() => void wallet.switchChain()}
        className="btn-outline"
        style={{ color: "var(--color-no)", borderColor: "var(--color-no)" }}
      >
        {t("wallet.switch", { chain: chain.name })}
      </button>
    );
  }

  return (
    <a
      href={`${chain.explorerUrl}/address/${wallet.address}`}
      target="_blank"
      rel="noreferrer"
      className="data chip px-3 py-1.5 text-[11px] text-[var(--color-foam-dim)] transition-colors hover:border-[var(--color-rule-bright)]"
    >
      {shortAddress(wallet.address)}
    </a>
  );
}
