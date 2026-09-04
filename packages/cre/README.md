# Pit's operating loop — Chainlink CRE

A five-minute binary needs two facts that live in different places: **when** the
window closed, which is onchain, and **what the price was**, which is not. CRE is
here because it is the one thing that can hold both inside a single attested
execution and produce a signed result the chain will accept. Rolling the next
column needs exactly those two facts as well — the strike ladder is anchored to
spot — so the workflow does both. It is not narration around a cron job: remove
it and there is no trustworthy settle, and no one opening the next column.

```
cron (30s)
   │
   ├─ 1. onchain clock   PitFactory.pendingSettlement(lookback, max)
   │                     → the windows past endTs that nobody has resolved
   │
   ├─ 2. offchain price  GET api.coinbase.com/v2/prices/BTC-USD/spot
   │                     → once per DON node, median across the DON
   │
   ├─ 3. settle report   abi.encode(priceE8, windowIds[])
   │                     DON signs → Forwarder → PitSettlementReceiver
   │                                             → PitFactory.settle(id, price)
   │
   └─ 4. roll report     abi.encode(underlying, windowSeconds, ends[], strikeE8s[])
                         DON signs → Forwarder → PitRollReceiver
                                                 → PitFactory.createWindow(...)
```

## The three decisions

**One report per column, not per cell.** Seven strikes close at the same instant
on a 5-minute grid. `pendingSettlement` returns them together and the receiver
loops, so a column costs one report instead of seven carrying the same price.
The roll is a second report with its own gas budget: opening a cell deploys two
ERC20s and two Kuru markets, and settlement should not wait behind that.

**The workflow is stateless.** It never remembers what it settled or opened. The
chain is the state; `pendingSettlement` and `missingWindows` are the queries, so
a missed tick, a restart or a redeploy all self-heal on the next run.

**The price is a scaled integer, end to end.** `parseE8` turns `"65123.45"` into
`6512345000000n` without a float in the middle. Median consensus runs over these
values and a window can settle on the last cent.

## Files

| File                             | What it is                                              |
| -------------------------------- | ------------------------------------------------------- |
| `settle-workflow/main.ts`        | the workflow: cron → clock → price → settle report → roll report |
| `settle-workflow/price.ts`       | decimal-string → 1e8 integer, testable on its own        |
| `settle-workflow/ladder.ts`      | hand-kept copy of `@pit/core` grid geometry              |
| `settle-workflow/abi.ts`         | the PitFactory fragments the workflow calls              |
| `settle-workflow/config.*.json`  | schedule, price URL, chain and contract addresses        |
| `settle-workflow/workflow.yaml`  | staging and production artifact paths                    |
| `project.yaml`                   | targets and RPCs                                         |
| `scripts/check.mjs`              | pre-flight: ABI drift, zero addresses, price parsing, ladder parity |
| `scripts/sync.mjs`               | copies deployed addresses into the configs               |

The onchain half is `PitSettlementReceiver.sol` and `PitRollReceiver.sol`.

## Running it

```bash
# 0. pre-flight — no CLI, no key, runs in CI
npm run check

# 1. point the configs at the deployment
npm run sync

# 2. install the CRE CLI (see docs.chain.link/cre), then
cd settle-workflow && bun install && cd ..
echo "CRE_ETH_PRIVATE_KEY=<64 hex chars, no 0x>" >> .env

# 3. simulate — compiles to WASM and runs locally against real RPCs and HTTP
npm run simulate

# 4. deploy and activate — needs deploy access on the account (cre account access)
npm run deploy
npm run activate
```

`npm run simulate` is the one to run in front of a judge: it makes the real
`pendingSettlement` and `missingWindows` calls against Monad testnet, the real
HTTP fetch to Coinbase, and prints the reports it would have written.

Steps 0 through 3 pass today. Step 4 does not run: `cre workflow deploy`
requires deploy access, which Chainlink grants per account, and ours was
declined. Everything upstream of the Forwarder is therefore exercised for real —
the WASM compiles, the DON's median consensus runs over the price fetch, both
factory reads answer from the deployed contracts, and both reports get built and
signed — while the one unproven step is a DON broadcasting them. The simulator
reports a write as `tx 0x`, which is how you can tell nothing was broadcast.

## Wiring the Forwarder

`PitFactory.settle` is gated on `settler` and `createWindow` on `operator`. The
deploy script leaves both as the deploy key so a demo is never blocked on CRE,
and deploys both receivers alongside the factory. Once the workflow is live and
you have the Forwarder address for your DON:

```solidity
receiver.setForwarder(<forwarder>);   // who may deliver settle reports
roller.setForwarder(<forwarder>);     // who may deliver roll reports
factory.setSettler(<receiver>);       // who may settle
factory.setOperator(<roller>);        // who may open cells
```

From that point the deploy key cannot settle or open anything. `tick` then
prints `roll: CRE owns the operator` and skips both stages, which is the
correct steady state.

## What is deliberately not done yet

The receiver trusts the Forwarder and ignores the report `metadata`, which also
carries the workflow id, owner and name. Pinning the workflow id in the receiver
would stop a second workflow owned by the same account from settling Pit's
windows. That is the next hardening step; today the mitigation is that
`PitFactory.voidWindow` lets anyone rescue a window an hour after it closes, so
a misbehaving settler can be removed without stranding anyone's collateral.
