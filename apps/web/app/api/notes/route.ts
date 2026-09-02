import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * The ciphertext store for encrypted cell notes.
 *
 * This endpoint is intentionally dumb, and that is the security property: it
 * holds opaque AES-GCM envelopes keyed by a hash of a passkey credential id, and
 * it will only return them to a caller that presents the vault's auth tag —
 * which is derived from the WebAuthn PRF output and therefore requires the
 * passkey. The server never sees a note, a key, or the PRF output itself.
 *
 * Storage is a JSON file. That is enough for a demo and honest about what it is;
 * swapping it for Postgres or KV is one function. What must not change is the
 * shape: ciphertext in, ciphertext out, no plaintext path.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NoteEnvelope = { v: 1; iv: string; ct: string; updatedAt: number };
type Vault = { authTag: string; notes: Record<string, NoteEnvelope> };
type Store = Record<string, Vault>;

const STORE_PATH = path.join(process.cwd(), ".data", "notes.json");

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

async function writeStore(store: Store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Constant-time compare, so the auth tag cannot be probed a byte at a time. */
function tagsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isVaultId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);

const isEnvelope = (value: unknown): value is NoteEnvelope => {
  const envelope = value as NoteEnvelope;
  return (
    !!envelope &&
    envelope.v === 1 &&
    typeof envelope.iv === "string" &&
    typeof envelope.ct === "string" &&
    envelope.iv.length <= 32 &&
    // ~8 KB of ciphertext is a long note and a hard ceiling on abuse.
    envelope.ct.length <= 12_000
  );
};

export async function GET(request: Request) {
  const vaultId = new URL(request.url).searchParams.get("vaultId");
  const authTag = request.headers.get("x-vault-auth");

  if (!isVaultId(vaultId) || !authTag) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const vault = (await readStore())[vaultId];
  if (!vault) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!tagsMatch(vault.authTag, authTag)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ notes: vault.notes });
}

export async function PUT(request: Request) {
  const authTag = request.headers.get("x-vault-auth");
  const body = (await request.json().catch(() => null)) as {
    vaultId?: string;
    cellKey?: string;
    envelope?: NoteEnvelope | null;
  } | null;

  if (!body || !isVaultId(body.vaultId) || !authTag || typeof body.cellKey !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (body.cellKey.length > 128) {
    return NextResponse.json({ error: "bad cell key" }, { status: 400 });
  }
  if (body.envelope !== null && !isEnvelope(body.envelope)) {
    return NextResponse.json({ error: "bad envelope" }, { status: 400 });
  }

  const store = await readStore();
  // First write claims the vault and pins its auth tag. Every later write has to
  // present the same one, so a vault id alone buys nothing.
  const vault = store[body.vaultId] ?? { authTag, notes: {} };
  if (!tagsMatch(vault.authTag, authTag)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (body.envelope === null) delete vault.notes[body.cellKey];
  else vault.notes[body.cellKey] = body.envelope;

  store[body.vaultId] = vault;
  await writeStore(store);

  return NextResponse.json({ ok: true, count: Object.keys(vault.notes).length });
}
