"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";

const STORAGE_KEY = "cell.risk.accepted.v1";

/**
 * The risk disclosure, shown once before the first order and reachable from the
 * header forever after.
 *
 * It gates the trade rather than sitting in a footer, because the thing being
 * disclosed — a binary that pays 1 or 0 — is the actual mechanic of the product,
 * not boilerplate. It is deliberately four sentences: a wall of text is a wall
 * nobody reads.
 */
export function useRiskGate() {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const pending = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => {
    try {
      setAccepted(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Without storage the disclosure simply shows once per session.
    }
  }, []);

  /** Resolves true once the trader has acknowledged; false if they dismiss. */
  const require = useCallback(async () => {
    if (accepted) return true;
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, [accepted]);

  const accept = useCallback(() => {
    setAccepted(true);
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* accepted for this session is still accepted */
    }
    pending.current?.(true);
    pending.current = null;
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    pending.current?.(false);
    pending.current = null;
  }, []);

  return { open, show: () => setOpen(true), accept, dismiss, require, accepted };
}

export function RiskDialog({
  open,
  onAccept,
  onDismiss,
}: {
  open: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const accept = useRef<HTMLButtonElement>(null);

  /**
   * A modal that does not take the focus is a modal a keyboard cannot reach:
   * Tab would walk the board behind it, and the one button that dismisses it
   * would be somewhere past the end of the page. Focus goes to Understood on
   * open, stays inside while it is up, and returns to whatever opened it.
   */
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    accept.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
        return;
      }
      // One focusable element, so Tab has nowhere else to go.
      if (event.key === "Tab") {
        event.preventDefault();
        accept.current?.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="risk-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1a1224]/70 p-4 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        className="panel max-w-md rounded-[28px] p-6 shadow-[0_10px_0_rgba(20,8,28,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="risk-title" className="mark mb-3 text-[28px] leading-none">
          {t("risk.title")}
        </h2>
        <p className="mb-5 text-[14px] leading-relaxed text-[var(--color-foam-dim)]">{t("risk.body")}</p>
        <button
          ref={accept}
          type="button"
          onClick={onAccept}
          className="btn-primary w-full"
        >
          {t("risk.accept")}
        </button>
      </div>
    </div>
  );
}
