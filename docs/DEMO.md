# The demo, in order

The bar: *a judge clicks a 5m cell, sees a live Kuru book, trades, and a
CRE-simulated settle flips the cell.* This is that path, with the commands.

Two ways to run it. **Testnet** is the real one. **Local** needs no faucet, no
Docker and no keys, and exercises the same code — the only substitution is a
`MockKuruRouter` standing in where Kuru is not deployed.

---

## Local, in four terminals

```bash
npm install
cp .env.example .env
npm run contracts:build
```

**1 — a chain**

```bash
npm --prefix packages/contracts run node
```

**2 — deploy, open the board, quote it**

```bash
npm --prefix packages/contracts run deploy:local
#   cUSD         0x…
#   PitFactory  0x…
#   Receiver     0x…

COLUMNS=6 npm --prefix packages/contracts run windows:roll:local
#   42 opened

npm --prefix packages/contracts run seed:local
#   + 10:40 $76,750  YES 0.517 / 0.537  200x  risk $103.4
#     10:40 $76,750  NO  0.463 / 0.483  200x  risk $92.6
#   80 books quoted
```

Note the YES and NO mids sum to 1.00. They have to.

**3 — index it**

```bash
npm --prefix packages/contracts run indexer:local
#   GraphQL on http://localhost:8080/v1/graphql
```

This is a development stand-in for `envio dev`, for machines without Docker. It
reads real logs with `eth_getLogs` and runs the *same* fold functions that ship
to Envio. Production is Envio — see `packages/indexer/README.md`.

**4 — the app**

```bash
cat > apps/web/.env.local <<'EOF'
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_EXPLORER_URL=http://127.0.0.1:8545
NEXT_PUBLIC_PIT_FACTORY=<from step 2>
NEXT_PUBLIC_COLLATERAL=<from step 2>
NEXT_PUBLIC_INDEXER_URL=http://localhost:8080/v1/graphql
NEXT_PUBLIC_PASSKEY_RP_ID=localhost
EOF

npm run dev
```

---

## What to look at

**The board.** Columns are five-minute windows, rows are strikes $50 apart, and
BTC is drawn across it with spot pinned to its own badge. The big number in a
cell is what it pays — `1.9x` — and the line under it is the probability, the
market width, and how many makers are behind it.

**A cell.** Click one. The panel gives you the claim in a sentence, the clock, the
payoff, and then the evidence: the live L2 book from the indexer, the tape
coloured by taker aggression, signed flow, and the addresses standing on the
book. The Kuru market address is a link — that book exists whether or not this
app does.

**A trade.** Connect a wallet and lift the offer, or:

```bash
FILLS=4 npm --prefix packages/contracts run demo:fills:local
#   + 10:40 $76,700  bought 25 YES @ 0.743  (1 trade)  0xa19f…
#   4 fill(s). Risked 74.10 for 100 of max payout.
```

Watch the ask shrink from 200 to 175 in the book, the print appear on the tape,
CVD step up on **Flow**, and the cell's volume count.

**Settlement.** Wait for a column to close, then:

```bash
npm --prefix packages/contracts run settle:local
#   #12  strike $76,700  ->  YES   tx 0x…
```

The cell flips to a green **YES** badge. Redeem from the panel and the winning
leg pays 1.00 a contract.

`settle:local` is the manual fallback so a demo is never blocked on CRE. The
production path is next.

**Private notes.** Open **Notes** on any cell, create a passkey, write something,
save. Then open the same cell on a second device and unlock with the same
passkey. [`docs/PASSKEY.md`](PASSKEY.md) has the whole check, including how to
confirm the server only ever held ciphertext.

---

## Testnet

```bash
# fund DEPLOYER_PRIVATE_KEY at https://faucet.monad.xyz
npm run deploy:testnet
npm run windows:roll
npm run seed
FILLS=4 npm --prefix packages/contracts run demo:fills
```

Indexer:

```bash
npm --prefix packages/indexer run sync
npm --prefix packages/indexer run validate     # works everywhere
npm --prefix packages/indexer run codegen      # needs Linux, macOS or WSL2
npm --prefix packages/indexer run dev
```

Until CRE is wired, `TICK_WATCH=1 npm --prefix packages/contracts run tick` keeps
the board full. After the Forwarder is set, CRE rolls and settles; `tick` only
seeds — quoting is a participant, not infrastructure.

---

## The CRE loop

```bash
npm --prefix packages/cre run check     # ABI drift, config addresses, price parsing
npm --prefix packages/cre run sync      # copy the deployed addresses into the config

cd packages/cre/settle-workflow && bun install && cd ..
echo "CRE_ETH_PRIVATE_KEY=<64 hex, no 0x>" >> .env

npm --prefix packages/cre run simulate
```

`cre workflow simulate` compiles the workflow to WASM and runs it locally against
**real** RPCs and the real price endpoint. It makes the actual
`pendingSettlement` and `missingWindows` calls to Monad testnet, fetches Coinbase
spot, and prints the reports it would have written:

```
2 window(s) waiting: 14, 15
BTC-USD reference price: $76,712.44
Settled 2 window(s) at $76,712.44 — tx 0x…
Opened 4 cell(s) — tx 0x…
```

To make it live, `cre workflow deploy` and `cre workflow activate`, then hand
both roles over:

```solidity
receiver.setForwarder(<the Forwarder for your DON>);
roller.setForwarder(<the Forwarder for your DON>);
factory.setSettler(<PitSettlementReceiver>);
factory.setOperator(<PitRollReceiver>);
```

After that the deploy key cannot settle or open anything. If the workflow ever
goes quiet, `voidWindow` lets anyone rescue a window an hour after it closed, and
both legs redeem at 0.50. A missed roll is noisier than a missed settle: the
board just has no next column until the next report lands.

---

## What to run if you only have five minutes

```bash
npm run contracts:test                     # 35 tests: issuance, settlement, roll, void, a fill end to end
npm --prefix packages/indexer run check    # config vs. ABIs, then 8 fold tests over a real event sequence
npm --prefix packages/cre run check        # the workflow's pre-flight
npm run build                              # the app
```

The most informative single test is
`packages/contracts/test/PitFactory.test.ts` →
*"end to end: seed the book, take the offer, redeem the winner"*. It mints sets,
quotes both sides, lifts the offer for 100 contracts at 0.44, settles above the
strike and checks the taker is up exactly $56 on $44 of risk.
