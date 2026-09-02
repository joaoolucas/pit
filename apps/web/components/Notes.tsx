"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import {
  decryptNote,
  describePasskeyError,
  encryptNote,
  enroll,
  forgetCredential,
  passkeysSupported,
  pullVault,
  pushNote,
  recallCredential,
  rememberCredential,
  unlock,
  type NotesSession,
} from "@/lib/notes";

/**
 * Private notes on a cell, encrypted behind a passkey.
 *
 * The point of this panel is a specific claim, and it should be checkable in
 * thirty seconds: write a note here, open the same URL on a second device, tap
 * the same passkey, and the note is there — while the server that stored it only
 * ever held ciphertext.
 *
 * The passkey is not the trading wallet and cannot become one. It derives one
 * AES key inside a salt namespace (see lib/notes.ts) and that key never leaves
 * this tab.
 */
export function Notes({ cellKey }: { cellKey: string }) {
  const { t } = useI18n();

  const [session, setSession] = useState<NotesSession | null>(null);
  const [busy, setBusy] = useState<"unlock" | "enroll" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const supported = passkeysSupported();
  const knownCredential = useRef(recallCredential());

  // Switching cells inside an unlocked session must not carry the previous
  // note across — that would be the fastest way to write a note about the
  // wrong strike.
  useEffect(() => {
    setText("");
    setDirty(false);
    setSaved(false);
    if (!session) return;

    let cancelled = false;
    void (async () => {
      try {
        const vault = await pullVault(session);
        const envelope = vault[cellKey];
        if (cancelled) return;
        setText(envelope ? await decryptNote(session, cellKey, envelope) : "");
      } catch (cause) {
        if (!cancelled) setError(describePasskeyError(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cellKey, session]);

  const open = useCallback(
    async (mode: "unlock" | "enroll") => {
      setBusy(mode);
      setError(null);
      try {
        const next =
          mode === "enroll" ? await enroll("Pit notes") : await unlock(knownCredential.current);
        rememberCredential(next.credential);
        knownCredential.current = next.credential;
        setSession(next);
      } catch (cause) {
        setError(describePasskeyError(cause));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const save = useCallback(async () => {
    if (!session) return;
    setBusy("save");
    setError(null);
    try {
      const trimmed = text.trim();
      const envelope = trimmed.length === 0 ? null : await encryptNote(session, cellKey, trimmed);
      await pushNote(session, cellKey, envelope);
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError(describePasskeyError(cause));
    } finally {
      setBusy(null);
    }
  }, [session, text, cellKey]);

  if (!supported) {
    return <p className="px-3 py-4 text-[11px] text-[var(--color-foam-faint)]">{t("notes.unsupported")}</p>;
  }

  if (!session) {
    return (
      <div className="flex flex-col gap-3 px-3 py-4">
        <p className="text-[11px] leading-relaxed text-[var(--color-foam-faint)]">{t("notes.blurb")}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void open("unlock")}
            disabled={busy !== null}
            className="btn-outline flex-1 py-1.5 text-[11px] disabled:opacity-50"
          >
            {busy === "unlock" ? t("notes.unlocking") : t("notes.unlock")}
          </button>
          <button
            type="button"
            onClick={() => void open("enroll")}
            disabled={busy !== null}
            className="btn-outline px-3 py-1.5 text-[11px] disabled:opacity-50"
          >
            {busy === "enroll" ? t("notes.unlocking") : t("notes.enroll")}
          </button>
        </div>
        {error && <p className="text-[11px] text-[var(--color-no)]">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-baseline justify-between">
        <span className="data text-[10px] text-[var(--color-foam-faint)]">
          {t("notes.crossDevice", { vault: session.vaultId.slice(0, 8) })}
        </span>
        <button
          type="button"
          onClick={() => {
            setSession(null);
            setText("");
            forgetCredential();
          }}
          className="text-[10px] text-[var(--color-foam-faint)] hover:text-[var(--color-foam-dim)]"
        >
          {t("notes.lock")}
        </button>
      </div>

      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDirty(true);
        }}
        placeholder={t("notes.placeholder")}
        rows={5}
        className="w-full resize-y rounded-[18px] border-2 rule bg-[var(--color-deep)] px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-[var(--color-rule-bright)]"
      />

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--color-yes)]">{saved ? t("notes.saved") : ""}</span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null || !dirty}
          className="btn-outline px-3 py-1 text-[11px] disabled:opacity-40"
        >
          {busy === "save" ? t("notes.saving") : t("notes.save")}
        </button>
      </div>

      {error && <p className="text-[11px] text-[var(--color-no)]">{error}</p>}
    </div>
  );
}
