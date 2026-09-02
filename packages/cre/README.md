# Pit settlement — Chainlink CRE

A five-minute binary needs two facts that live in different places: **when** the
window closed, which is onchain, and **what the price was**, which is not. CRE is
here because it is the one thing that can hold both inside a single attested
execution and produce a signed result the chain will accept. It is not narration
around a cron job — remove it and there is no trustworthy settle.

```
cron (30s)
   │
   ├─ 1. onchain clock   PitFactory.pendingSettlement(lookback, max)
   │                     → the windows past endTs that nobody has resolved
   │
   ├─ 2. offchain price  GET api.coinbase.com/v2/prices/BTC-USD/spot
   │                     → once per DON node, median across the DON
   │
   └─ 3. one report      abi.encode(priceE8, windowIds[])
                         DON signs → Forwarder → PitSettlementReceiver
                                                 → PitFactory.settle(id, price)
```

## The three decisions

**One report per column, not per cell.** Seven strikes close at the same instant
on a 5-minute grid. `pendingSettlement` returns them together and the receiver
loops, so a column costs one report instead of seven carrying the same price.

**The workflow is stateless.** It never remembers what it settled. The chain is
the state and `pendingSettlement` is the query, so a missed tick, a restart or a
redeploy all self-heal on the next run.

**The price is a scaled integer, end to end.** `parseE8` turns `"65123.45"` into
`6512345000000n` without a float in the middle. Median consensus runs over these
values and a window can settle on the last cent.

## Files

| File                             | What it is                                              |
| -------------------------------- | ------------------------------------------------------- |
| `settle-workflow/main.ts`        | the workflow: cron → read → price → report → write       |
| `settle-workflow/price.ts`       | decimal-string → 1e8 integer, testable on its own        |
| `settle-workflow/abi.ts`         | the single PitFactory fragment the workflow calls       |
| `settle-workflow/config.*.json`  | schedule, price URL, chain and contract addresses        |
| `settle-workflow/workflow.yaml`  | staging and production artifact paths                    |
| `project.yaml`                   | targets and RPCs                                         |
| `scripts/check.mjs`              | pre-flight: ABI drift, zero addresses, price parsing     |
| `scripts/sync.mjs`               | copies deployed addresses into the configs               |

The onchain half is `packages/contracts/contracts/PitSettlementReceiver.sol`.

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

# 4. deploy and activate
npm run deploy
npm run activate
```

`npm run simulate` is the one to run in front of a judge: it makes the real
`pendingSettlement` call against Monad testnet, the real HTTP fetch to Coinbase,
and prints the report it would have written.

## Wiring the Forwarder

`PitFactory.settle` is gated on a single `settler` address. The deploy script
leaves that as the deploy key so a demo is never blocked on CRE, and deploys
`PitSettlementReceiver` alongside it. Once the workflow is live and you have the
Forwarder address for your DON:

```solidity
receiver.setForwarder(<forwarder>);   // who may deliver reports
factory.setSettler(<receiver>);       // who may settle
```

From that point the deploy key cannot settle anything.

## What is deliberately not done yet

The receiver trusts the Forwarder and ignores the report `metadata`, which also
carries the workflow id, owner and name. Pinning the workflow id in the receiver
would stop a second workflow owned by the same account from settling Pit's
windows. That is the next hardening step; today the mitigation is that
`PitFactory.voidWindow` lets anyone rescue a window an hour after it closes, so
a misbehaving settler can be removed without stranding anyone's collateral.
