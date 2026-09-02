"use client";

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
} from "@category-labs/mera";

import { passkeyRpId } from "./config";

/**
 * Private cell notes, encrypted behind a passkey.
 *
 * What this is NOT: a wallet. The PRF output derived here never becomes a
 * signing key, never touches a transaction, and lives in a different file from
 * everything that does (lib/wallet.ts). Mera can derive EVM accounts from a
 * passkey; Cell deliberately does not use it that way. Trading is signed by an
 * ordinary Monad wallet.
 *
 * What this IS: one PRF salt namespace, used to derive one AES-256-GCM key that
 * encrypts a trader's notes and call drafts on a cell. The ciphertext is stored
 * on Cell's server; the key is never sent anywhere and never persisted. The same
 * passkey on a second device derives the same key from the same salt and reads
 * the same notes, which is the whole point.
 *
 *   salt      SHA-256("cell.prf.v1|<rpId>|notes")     — the namespace
 *   PRF       WebAuthn hmac-secret over that salt      — 32 bytes, per credential
 *   key       HKDF-SHA-256(PRF, info "cell.v1.notes.aead")
 *   auth tag  HKDF-SHA-256(PRF, info "cell.v1.notes.auth")  — proves possession
 *             to the server without revealing anything about the key
 *
 * The salt is a namespace, not a secret: it is derived from a constant and the
 * relying-party id, so it is identical on every device and reproducible from
 * this source. Its job is domain separation — a second namespace (say
 * "cell.prf.v1|<rpId>|drafts") yields a completely unrelated key from the same
 * passkey, so notes and drafts cannot decrypt each other.
 */

const NAMESPACE_PREFIX = "cell.prf.v1";
const AEAD_INFO = "cell.v1.notes.aead";
const AUTH_INFO = "cell.v1.notes.auth";
const HKDF_SALT = "cell.notes.hkdf.v1";

export type PasskeyCredential = {
  credentialId: string;
  transports?: readonly string[];
};

/** An unlocked session. Holds key material in memory only, for this tab. */
export type NotesSession = {
  credential: PasskeyCredential;
  vaultId: string;
  authTag: string;
  key: CryptoKey;
};

export type NoteEnvelope = {
  v: 1;
  iv: string;
  ct: string;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * The salt namespace. Deterministic and public by design: reproducing it is how
 * a second device gets the same PRF output for the same passkey.
 */
export async function namespaceSalt(namespace: "notes" | "drafts" = "notes"): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${NAMESPACE_PREFIX}|${passkeyRpId}|${namespace}`),
  );
  return new Uint8Array(digest);
}

async function deriveMaterial(prfOutput: Uint8Array) {
  const ikm = await crypto.subtle.importKey("raw", prfOutput as BufferSource, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);

  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(AEAD_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the key cannot leave this tab, even by mistake
    ["encrypt", "decrypt"],
  );

  const authBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(AUTH_INFO) },
    ikm,
    256,
  );

  return { key, authTag: toBase64Url(new Uint8Array(authBits)) };
}

/** A public identifier for the vault. Reveals nothing: it is a hash of the id. */
async function vaultIdFor(credentialId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`cell.vault.v1|${credentialId}`));
  return toBase64Url(new Uint8Array(digest)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.PublicKeyCredential) && Boolean(crypto?.subtle);
}

/** First time on any device: create the passkey and open a session. */
export async function enroll(label: string): Promise<NotesSession> {
  const prfSalt = await namespaceSalt("notes");
  const result = await createPasskeyWithPrfOutput({
    rp: { id: passkeyRpId, name: "Cell" },
    user: { name: label, displayName: label },
    prfSalt,
  });

  const { key, authTag } = await deriveMaterial(result.prfOutput);
  return {
    credential: { credentialId: result.credentialId, transports: result.transports },
    vaultId: await vaultIdFor(result.credentialId),
    authTag,
    key,
  };
}

/**
 * Any later time, on any device: assert the same passkey over the same salt.
 *
 * `credential` is omitted so the platform offers whichever passkey it has for
 * this site — on a second device that is the synced one, and it produces the
 * same 32 bytes, which is exactly the cross-device property being demonstrated.
 */
export async function unlock(credential?: PasskeyCredential): Promise<NotesSession> {
  const prfSalt = await namespaceSalt("notes");
  const result = await getPasskeyPrfOutput({
    rpId: passkeyRpId,
    credential: credential as never,
    prfSalt,
  });

  const { key, authTag } = await deriveMaterial(result.prfOutput);
  return {
    credential: { credentialId: result.credentialId },
    vaultId: await vaultIdFor(result.credentialId),
    authTag,
    key,
  };
}

export function describePasskeyError(error: unknown): string {
  if (isMeraError(error)) {
    switch (error.code) {
      case "PRF_UNAVAILABLE":
        return "This authenticator does not support the WebAuthn PRF extension. Try a platform passkey (Touch ID, Windows Hello, Android).";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey prompt was cancelled or unavailable.";
      case "CRYPTO_UNAVAILABLE":
        return "WebCrypto is unavailable. Notes need a secure context (https or localhost).";
      case "DECRYPT_FAILED":
        return "Those notes were encrypted with a different passkey.";
      default:
        return error.message;
    }
  }
  return (error as Error)?.message ?? "Unknown passkey error";
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * The cell key is bound in as additional authenticated data, so a note cannot be
 * moved from one cell to another even by whoever holds the ciphertext.
 */
export async function encryptNote(session: NotesSession, cellKey: string, plaintext: string): Promise<NoteEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(cellKey) },
    session.key,
    encoder.encode(plaintext),
  );

  return {
    v: 1,
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
    updatedAt: Date.now(),
  };
}

export async function decryptNote(
  session: NotesSession,
  cellKey: string,
  envelope: NoteEnvelope,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(envelope.iv) as BufferSource,
      additionalData: encoder.encode(cellKey),
    },
    session.key,
    fromBase64Url(envelope.ct) as BufferSource,
  );
  return decoder.decode(plaintext);
}

// ---------------------------------------------------------------------------
// Server sync
//
// The server holds ciphertext keyed by a hash of the credential id, and will
// only hand it back to a caller that can present the auth tag — which requires
// the PRF output, which requires the passkey. It never sees a key or a note.
// ---------------------------------------------------------------------------

export type VaultContents = Record<string, NoteEnvelope>;

export async function pullVault(session: NotesSession): Promise<VaultContents> {
  const response = await fetch(`/api/notes?vaultId=${encodeURIComponent(session.vaultId)}`, {
    headers: { "x-vault-auth": session.authTag },
  });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Vault read failed: ${response.status}`);
  const body = (await response.json()) as { notes?: VaultContents };
  return body.notes ?? {};
}

export async function pushNote(session: NotesSession, cellKey: string, envelope: NoteEnvelope | null) {
  const response = await fetch("/api/notes", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-vault-auth": session.authTag },
    body: JSON.stringify({ vaultId: session.vaultId, cellKey, envelope }),
  });
  if (!response.ok) throw new Error(`Vault write failed: ${response.status}`);
}

/**
 * The credential id is the only thing worth remembering between visits, and it
 * is not a secret — it just saves the platform from asking which passkey.
 */
const CREDENTIAL_STORAGE_KEY = "cell.notes.credential.v1";

export function rememberCredential(credential: PasskeyCredential) {
  try {
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));
  } catch {
    // Private windows and locked-down browsers: the passkey still works, the
    // platform just has to ask which one.
  }
}

export function recallCredential(): PasskeyCredential | undefined {
  try {
    const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PasskeyCredential) : undefined;
  } catch {
    return undefined;
  }
}

export function forgetCredential() {
  try {
    localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    /* nothing to forget */
  }
}
