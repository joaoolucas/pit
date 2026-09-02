"use client";

import { chain, isConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { useWallet } from "@/lib/wallet";
import { e8ToUsd, shortAddress } from "@cell/core";

type Props = {
  spotE8: bigint | null;
  /** Move over the window the trace covers, as a fraction. Null until known. */
  changePct: number | null;
  indexerAgeSeconds: number | null;
  indexerDown: boolean;
  onOpenRisk: () => void;
};

export function Header({ spotE8, changePct, indexerAgeSeconds, indexerDown, onOpenRisk }: Props) {
  const { t, locale, setLocale } = useI18n();

  return (
    <header className="shrink-0 border-b rule bg-[var(--color-hull)]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
        {/* The mark: a board, four cells, one lit. */}
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="grid grid-cols-2 gap-[2px]">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="block size-[5px] rounded-[1px]"
                style={{
                  background: i === 1 ? "var(--color-yes)" : "var(--color-rule-bright)",
                }}
              />
            ))}
          </span>
          <span className="readout text-[14px] font-semibold tracking-[-0.02em]">Cell</span>
          <span className="hidden text-[11px] text-[var(--color-foam-faint)] xl:inline">
            {t("app.tagline")}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-5">
          {/* Spot anchors every strike on the board, so it goes first and never
              moves. */}
          <div className="flex items-baseline gap-2">
            <span className="label">BTC</span>
            <span className="readout text-[17px] font-semibold leading-none">
              {spotE8 === null
                ? "—"
                : e8ToUsd(spotE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
            {changePct !== null && (
              <span
                className="data text-[11px]"
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
            className="text-[11px] text-[var(--color-foam-dim)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--color-foam)]"
          >
            {t("risk.more")}
          </button>

          <div className="flex overflow-hidden rounded-[3px] border rule text-[11px]">
            {(["pt-BR", "en"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLocale(option)}
                aria-pressed={locale === option}
                className="px-2 py-1 transition-colors"
                style={{
                  background: locale === option ? "var(--color-raised)" : "transparent",
                  color: locale === option ? "var(--color-foam)" : "var(--color-foam-faint)",
                }}
              >
                {option === "pt-BR" ? "PT" : "EN"}
              </button>
            ))}
          </div>

          <WalletButton />
        </div>
      </div>

      {!isConfigured && (
        <p className="border-t rule bg-[color-mix(in_oklab,var(--color-no)_12%,transparent)] px-4 py-1.5 text-[11px] text-[var(--color-foam-dim)]">
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
    <div className="flex items-center gap-1.5" title={t("status.indexer")}>
      <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: colour }} />
      <span className="text-[11px] text-[var(--color-foam-dim)]">
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
      className="data rounded-[3px] border rule px-2.5 py-1 text-[11px] text-[var(--color-foam-dim)] transition-colors hover:border-[var(--color-rule-bright)]"
    >
      {shortAddress(wallet.address)}
    </a>
  );
}
