"use client";

import { chain, isConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n";
import { useWallet } from "@/lib/wallet";
import { e8ToUsd, shortAddress } from "@cell/core";

type Props = {
  spotE8: bigint | null;
  indexerAgeSeconds: number | null;
  indexerDown: boolean;
  onOpenRisk: () => void;
};

export function Header({ spotE8, indexerAgeSeconds, indexerDown, onOpenRisk }: Props) {
  const { t, locale, setLocale } = useI18n();
  const wallet = useWallet();

  return (
    <header className="border-b hairline bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Cell</span>
          <span className="hidden text-[11px] text-[var(--color-ink-faint)] lg:inline">
            {t("app.tagline")}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-5">
          {/* Spot is the anchor for every strike on the board, so it sits first
              and never moves. */}
          <div className="flex items-baseline gap-2">
            <span className="label">BTC</span>
            <span className="num text-[15px] tabular-nums">
              {spotE8 === null ? "—" : `$${e8ToUsd(spotE8).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </span>
          </div>

          <IndexerPill ageSeconds={indexerAgeSeconds} down={indexerDown} />

          <button
            type="button"
            onClick={onOpenRisk}
            className="text-[11px] text-[var(--color-ink-dim)] underline decoration-dotted underline-offset-4 hover:text-[var(--color-ink)]"
          >
            {t("risk.more")}
          </button>

          <div className="flex overflow-hidden rounded border hairline text-[11px]">
            {(["pt-BR", "en"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLocale(option)}
                aria-pressed={locale === option}
                className={
                  locale === option
                    ? "bg-[var(--color-raised)] px-2 py-1 text-[var(--color-ink)]"
                    : "px-2 py-1 text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]"
                }
              >
                {option === "pt-BR" ? "PT" : "EN"}
              </button>
            ))}
          </div>

          <WalletButton />
        </div>
      </div>

      {!isConfigured && (
        <p className="border-t hairline bg-[var(--color-no-dim)] px-4 py-1.5 text-[11px] text-[var(--color-ink-dim)]">
          {t("status.notConfigured")}
        </p>
      )}
    </header>
  );
}

function IndexerPill({ ageSeconds, down }: { ageSeconds: number | null; down: boolean }) {
  const { t } = useI18n();

  // Three states, and the middle one matters: a book that is ten seconds behind
  // on a five-minute market is a book you should not lift.
  const waiting = !down && ageSeconds === null;
  const stale = !down && ageSeconds !== null && ageSeconds > 5;
  const colour = down
    ? "var(--color-no)"
    : waiting
      ? "var(--color-ink-faint)"
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
      <span className="inline-block size-1.5 rounded-full" style={{ background: colour }} />
      <span className="text-[11px] text-[var(--color-ink-dim)]">
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
    return <span className="text-[11px] text-[var(--color-ink-faint)]">{t("wallet.none")}</span>;
  }

  if (!wallet.address) {
    return (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={wallet.connecting}
        className="rounded border border-[var(--color-line-bright)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)] disabled:opacity-50"
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
        className="rounded border border-[var(--color-no)] px-3 py-1 text-[11px] text-[var(--color-no)]"
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
      className="num rounded border hairline px-3 py-1 text-[11px] text-[var(--color-ink-dim)] hover:border-[var(--color-line-bright)]"
    >
      {shortAddress(wallet.address)}
    </a>
  );
}
