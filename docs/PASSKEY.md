# The passkey is not the wallet

Pit uses [mera](https://github.com/category-labs/mera) and WebAuthn's PRF
extension. It deliberately does **not** use them the way the library's headline
demo does.

Mera can derive an EVM account from a passkey. Pit does not do that. The PRF
output derived here never becomes a signing key, never touches a transaction, and
lives in a different file (`apps/web/lib/notes.ts`) from everything that signs
(`apps/web/lib/wallet.ts`). Trading is signed by an ordinary Monad wallet.

## What it does instead

Encrypts your private notes on a cell — why you are in it, the level you are
watching, a draft of a call you have not sent — so that the same passkey on a
second device opens the same notes, and nothing readable is ever stored on a
server.

```
namespace   "pit.prf.v1|<rpId>|notes"
salt        SHA-256(namespace)                       32 bytes, public, deterministic
PRF         WebAuthn hmac-secret over that salt      32 bytes, per credential
key         HKDF-SHA-256(PRF, info "cell.v1.notes.aead")  → AES-256-GCM, non-extractable
auth tag    HKDF-SHA-256(PRF, info "cell.v1.notes.auth")  → proves possession to the server
vault id    SHA-256("cell.vault.v1|" + credentialId)      → a public handle
```

## Why a salt namespace and not a random salt

The salt is a namespace, not a secret. It is derived from a constant and the
relying-party id, so it is identical on every device and reproducible from this
source — which is exactly what makes the cross-device property work: the same
credential over the same salt returns the same 32 bytes, on any device the
passkey has synced to.

Its job is domain separation. A second namespace
(`pit.prf.v1|<rpId>|drafts`) yields a completely unrelated key from the same
passkey, so notes and drafts cannot decrypt each other, and neither could a
future feature that happened to reuse the credential.

Mera's own `createSecretVaultWithNewPasskey` generates a fresh random salt per
vault, which is the right default for a single high-value secret. Pit needs many
small secrets under one unlock, so it evaluates a namespaced salt with
`getPasskeyPrfOutput` and derives one key for the session.

## What the server can and cannot do

`apps/web/app/api/notes/route.ts` holds opaque AES-GCM envelopes keyed by the
vault id, and returns them only to a caller presenting the vault's auth tag.

- It never sees a note, a key, or the PRF output.
- The auth tag is derived from the PRF output through a *different* HKDF info
  string, so holding it tells you nothing about the encryption key.
- The tag is compared in constant time, so it cannot be probed a byte at a time.
- Each note is bound to its cell key as AES-GCM additional authenticated data, so
  whoever holds the ciphertext cannot move a note from one cell to another.

Storage is a JSON file. That is honest about what it is for a demo, and swapping
it for Postgres or KV is one function. What must not change is the shape:
ciphertext in, ciphertext out, no plaintext path.

## The cross-device test

This is the claim, and it should take under a minute to check.

1. On device A, open a cell → **Notes** → **Create passkey**. Save it to a synced
   passkey provider (iCloud Keychain, Google Password Manager, 1Password).
2. Write a note. Press **Save**. The tab holds the key; the server gets an
   envelope.
3. On device B — a phone, another laptop, or the same browser with site data
   cleared — open the same URL and the same cell → **Notes** → **Unlock with
   passkey**. Pick the synced passkey.
4. The note is there.

To see that the server really is blind, hit the API directly with the vault id
from the panel:

```bash
curl "http://localhost:3000/api/notes?vaultId=<the id shown in the panel>" \
     -H "x-vault-auth: obviously-wrong"
# {"error":"forbidden"}
```

And read the file it stores:

```bash
cat apps/web/.data/notes.json
# {"<vaultId>":{"authTag":"…","notes":{"BTC-USD:1788355200:7675000000000":
#   {"v":1,"iv":"…","ct":"…","updatedAt":…}}}}
```

## Requirements and failure modes

PRF needs a platform authenticator that implements it — Touch ID, Windows Hello,
Android, or a modern security key — and a secure context (`https`, or
`localhost`). `NEXT_PUBLIC_PASSKEY_RP_ID` must equal the site host with no scheme
and no port.

The panel names each failure rather than showing a generic error:
`PRF_UNAVAILABLE` says the authenticator does not do PRF and suggests a platform
passkey; `DECRYPT_FAILED` says the notes belong to a different passkey;
`CRYPTO_UNAVAILABLE` says the page is not in a secure context.

## What this is not

It is not a backup. Lose every device holding the passkey and the notes are
unrecoverable, because that is what "the server cannot read them" means. A
recovery flow would be a second namespace and a second credential, and it is not
built.
