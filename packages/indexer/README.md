# Cell indexer — Envio HyperIndex

The book a cell shows is this indexer. Nothing in the app polls an RPC for logs.

```
CellFactory.WindowCreated ──► contractRegister ──► both Kuru markets followed
                          └─► Window, Market, CellState rows

KuruOrderBook.OrderCreated ─┐
KuruOrderBook.Trade ────────┼─► BookLevel · MarketMaker · Fill · WindowCvd · CellState
KuruOrderBook.OrdersCanceled┘
```

The interesting part is `contractRegister`. A window's two Kuru markets are
deployed by `CellFactory.createWindow` at runtime, so their addresses cannot be
in `config.yaml`. `src/handlers/factory.ts` adds both the moment `WindowCreated`
is emitted, and `src/handlers/orderbook.ts` starts receiving their logs in the
same block. A cell that opens while the indexer is running is indexed from its
first order, with no restart and no address list to maintain.

## Derived entities

| Entity        | What it answers                                                        |
| ------------- | ---------------------------------------------------------------------- |
| `BookLevel`   | depth at each price, per side — this *is* the L2 book the cell renders  |
| `MarketMaker` | who is quoting; keeps `CellState.makers` an exact distinct count        |
| `CellState`   | one denormalised row per cell so the grid paints ~50 cells in one query |
| `WindowCvd`   | signed taker flow in 15-second buckets                                  |
| `Fill`        | the tape                                                               |
| `Window`      | issuance, open interest and settlement, from CellFactory's own events   |

`CellState.cvd` is the running total and `WindowCvd.delta` is the per-bucket
change, so the tape chart needs one query and no client-side accumulation.

## Running it

```bash
npm install
npm run sync            # copy CellFactory address + start block from the deployment
npm run validate        # config.yaml vs. the ABIs, no container needed
npm run codegen
npm run dev             # Postgres + Hasura on http://localhost:8080/v1/graphql
```

Point the web app at it with `NEXT_PUBLIC_INDEXER_URL=http://localhost:8080/v1/graphql`.

### On Windows

The `envio` CLI ships binaries for Linux and macOS only, so `codegen`, `dev` and
`start` must run under **WSL2** (or any Linux/macOS box, or Envio Cloud). From a
WSL shell:

```bash
cd /mnt/c/Users/<you>/Documents/projects/monad/packages/indexer
npm install && npm run codegen && npm run dev
```

`npm run validate` is the part that does work natively on Windows: it checks
`config.yaml` against the JSON schema shipped inside the `envio` package and
cross-checks every declared event signature against the ABI in `abis/`. That
catches the failures codegen would catch — a mistyped event, a missing ABI, a
contract wired to no chain — which is why it also runs in CI.

### Envio Cloud

```bash
envio login
envio deploy
```

Then set `NEXT_PUBLIC_INDEXER_URL` to the deployment's GraphQL endpoint.

## Keeping the ABIs honest

`abis/*.json` is generated, not hand-written:

```bash
npm --prefix ../contracts run export:abi
```

It writes the compiled CellFactory ABI and copies Kuru's `OrderBook.json`
straight out of `@kuru-labs/kuru-sdk` when that package is installed, so the
event signatures here are the ones Kuru actually emits rather than a
transcription of the docs.

## Queries

`queries/` holds the exact documents the web app sends — `grid.graphql` for the
board, `cell.graphql` for one cell's book and tape. They are readable on their
own and are the fastest way to see what the app asks for.
