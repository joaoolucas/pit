# Submission map

What Pit is entering, why, and where the evidence for each claim lives. Checked
against `hackathon.monad.xyz/tracks` and the Onchain Finance & Trading judging
criteria.

## Primary track

**Onchain Finance & Trading** — $30,000.

> *"the core output is a financial instrument, market, asset primitive, or trading
> experience — and the primary user is a trader"*

Pit is all three: the instrument (a 5-minute binary), the market structure (two
CLOB books per window that sum to 1), and the trading experience (the grid). The
track's own core question is *"what new trading experiences become possible when
settlement is fast enough to stop being the bottleneck?"* — a 5-minute binary
with a real book only exists at 400ms blocks. On a 12-second chain the book is
fiction, which is the sentence the whole project is built around.

Two of the track's suggested starting points land on it directly: *"prediction
markets for outcomes that have no existing venue"* and *"execution-aware trading
interfaces that expose Monad's sub-second finality — real-time fills, live order
books, no pending states."*

## Bounties

| Bounty | Prize | Why Pit qualifies | Evidence |
| --- | --- | --- | --- |
| **Bring New Assets and Markets to Kuru** | $5,000 | A new class of tradable market — short-horizon binaries — *plus the infrastructure to make them viable*, which is the part the bounty asks for: the window roller, the two-sided seeder, and the indexer that turns Kuru's logs into a book. | `PitFactory.createWindow` → `Router.deployProxy` ×2; `scripts/roll-windows.ts`; `scripts/seed.ts`; [`docs/LIQUIDITY.md`](LIQUIDITY.md) |
| **Build the Next Consumer Trading App on Kuru** | $5,000 | The grid *is* the trading UI. Every order routes through the Kuru SDK; there is no internal matching and no simulated mode. | `apps/web/lib/kuru.ts` (`GTC.placeLimit`, `OrderCanceler.cancelOrders`), `components/OrderTicket.tsx` |
| **Best Use of Envio** | $1,000 | The book a cell shows *is* the index. `contractRegister` follows markets that did not exist when the indexer started; the app never polls an RPC for logs. | `packages/indexer/` — `config.yaml`, `schema.graphql`, `src/folds.ts`, 8 tests |
| **Best workflow with CRE** | $3,000 | CRE is the settlement path, not a comment: onchain clock + offchain price in one attested execution, one signed report per column. The bounty accepts *simulate*, and `cre workflow simulate` passes end to end against the deployed testnet contracts — median-consensus price fetch, both factory reads, both signed reports. It has not run on a DON: deploy access is granted per account and ours was declined, which gates the Forwarder and nothing upstream of it. | `packages/cre/settle-workflow/main.ts`, `contracts/PitSettlementReceiver.sol`, 6 receiver tests |
| **Mera: One Passkey, Many Keys** | $2,500 | *"Most creative non-wallet use of PRF-derived key material."* A PRF salt namespace encrypts private cell notes; the derived key never signs anything. | `apps/web/lib/notes.ts`, [`docs/PASSKEY.md`](PASSKEY.md) |

**$16,500 in bounties**, against a $30,000 track and a $25,000 Grand Champion.

## Bounties deliberately not entered

| Bounty | Prize | Why not |
| --- | --- | --- |
| **Best Mera-Powered UX** | $2,500 | Wants Mera as *the entire account layer — no extension, no custody backend*. Pit signs with an ordinary Monad wallet on purpose, so the passkey can never move funds. Taking both Mera bounties would mean arguing the passkey is and is not the wallet. We chose the non-wallet one and said why. |
| **Agora: Mobile Trading / Cross-Border** | $10,000 each | Both require a mobile app; the trading one also requires Perpl and an AUSD balance. A different product. |
| **Perpl: API bot / Analytics** | $5,000 / $3,000 | Perpl is a perps venue. Pit's whole claim is a spot CLOB of binaries. |
| **Dynamic / Privy** | $5,000 each | Wallet-auth SDKs. Pit's account story is one sentence — bring a Monad wallet — and Privy explicitly disqualifies login-only integrations. |
| **Cleanverse / Hunyuan / KIMI / Qwen** | — | Identity gating and LLM credits. Nothing in Pit needs a model. |
| **Alchemy** | $1,000 credits | Swapping a public RPC for an Alchemy RPC is not a *meaningful* integration, which is the stated bar. |

## Worth considering, not yet built

Two that fit without distorting the product:

**Aurora Intents — $5,000, all tracks.** *Any-chain deposits, swaps, or
deposit-and-execute.* This closes a real gap rather than adding a logo: today you
need collateral already on Monad before you can trade a cell. A
deposit-and-execute intent — arrive from any chain, land as collateral, mint a
set — is the missing first step of the funnel. Highest-value addition on the
board for us.

**MetaMask Best Agent Wallet Plugin — $2,500, in our track.** A plugin that
teaches an agent wallet to quote or take 5-minute binaries. Genuinely adjacent —
the seeding script is already a bot — but it is a second product surface, so it
comes after the live deploy.

## Judging criteria, and where we stand

| Criterion | Weight | Where we are |
| --- | --- | --- |
| **Technical Execution** — *real settlement and matching, not a UI over static data* | 20% | Strong in code: real Kuru books, real onchain settlement, 47 tests. **Needs the testnet deploy** to be checkable by a judge. |
| **Design & Craft** — *trustworthy and legible; clear pricing and risk disclosure* | 20% | Strong. Payout multiple as the headline, the market width and maker count under it, a risk gate before the first order, pt-BR and EN. |
| **Originality & Track Insight** — *new primitive, or a faster clone?* | 15% | Strong. Binaries on a CLOB rather than against a house; the grid is the same product as up/down, generalised to a strike ladder. |
| **Founder & Market Readiness** — *name a specific first user beyond "crypto traders"* | **25%** | Answered in the README: orderflow traders who already have Grid Arena open, and the table saying what a book gives them that a tile cannot. This is the heaviest criterion and it belongs in the pitch video, not only here. |
| **Traction & Path Forward** — *evidence of testing, and a specific next step with a target* | 20% | Partial. `demo:fills` produces replayable fills and the 30-day plan is concrete, but the targets need to be numbers and there is no external liquidity partner yet. |

## Deliverables

| Required | Status |
| --- | --- |
| Public GitHub repo, accessible by `metropolis@hackathon.monad.xyz` | **Not pushed.** No remote configured yet. |
| Live product link on Monad mainnet or testnet, with access instructions | **Missing — the biggest gap.** Needs a funded key for `deploy:testnet`, an Envio Cloud indexer, and a host for the app. |
| Technical demo video, ≤3 min, live product not slides | Not recorded. The path to film is [`docs/DEMO.md`](DEMO.md). |
| Pitch video, ≤2 min — team, problem, why you | Not recorded. |
| Project logo/graphic, JPG/PNG/WEBP ≤3MB | Not made. |
| Product advertisement, ≤30s (optional, not judged) | Not made. |

The order that matters: **testnet deploy → public repo → demo video**. Everything
else is already written down.
