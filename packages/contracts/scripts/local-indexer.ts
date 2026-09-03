/**
 * A local stand-in for `envio dev`, for machines without Docker.
 *
 * The Envio CLI ships Linux and macOS binaries and `envio dev` wants a Postgres
 * and a Hasura container, which is a lot to ask of someone who just cloned this
 * to look at it. This script gets a developer to the same place on any OS:
 *
 *   - it reads real logs from the chain with eth_getLogs, exactly the events
 *     config.yaml declares
 *   - it discovers each window's two Kuru markets from WindowCreated, which is
 *     what contractRegister does in production
 *   - it folds them with the *same* functions the deployed indexer runs
 *     (packages/indexer/src/folds.ts) — there is no second implementation
 *   - it serves the same GraphQL shape the app queries, on the same port
 *
 * What it is not: production. There is no Postgres, no reorg handling, no
 * historical backfill worth the name, and the resolver understands only the four
 * documents this app sends. Ship Envio. Use this to see the thing move.
 *
 *   npx hardhat run scripts/local-indexer.ts --network localhost
 */
import http from "node:http";
import { ethers } from "hardhat";
import { Interface } from "ethers";

import { readDeployment } from "./lib";
import { createMemoryStore } from "../../indexer/src/memory-store";
import {
  applyCollateralDelta,
  applyOrderCreated,
  applyOrdersCanceled,
  applyTrade,
  applyWindowCreated,
  applyWindowResolved,
} from "../../indexer/src/folds";
import { OUTCOME } from "../../indexer/src/shared";

const PORT = Number(process.env.LOCAL_INDEXER_PORT ?? 8080);
const POLL_MS = Number(process.env.LOCAL_INDEXER_POLL ?? 500);

const factoryIface = new Interface([
  "event WindowCreated(uint256 indexed windowId, bytes32 indexed underlying, uint64 startTs, uint64 endTs, uint256 strikeE8, address yes, address no, address yesMarket, address noMarket)",
  "event SetMinted(uint256 indexed windowId, address indexed account, uint256 amount)",
  "event SetBurned(uint256 indexed windowId, address indexed account, uint256 amount)",
  "event WindowSettled(uint256 indexed windowId, uint8 outcome, uint256 settlePriceE8, uint64 settledAt)",
  "event WindowVoided(uint256 indexed windowId, uint64 voidedAt)",
  "event Redeemed(uint256 indexed windowId, address indexed account, uint256 burned, uint256 payout)",
]);

const bookIface = new Interface([
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
]);

async function main() {
  const deployment = readDeployment();
  const provider = ethers.provider;
  const memory = createMemoryStore();
  const markets = new Set<string>();

  let cursor = deployment.startBlock;
  console.log(`Local indexer: PitFactory ${deployment.pitFactory} from block ${cursor}`);

  const blockTimes = new Map<number, number>();
  const timestampOf = async (blockNumber: number) => {
    let cached = blockTimes.get(blockNumber);
    if (cached === undefined) {
      cached = (await provider.getBlock(blockNumber))?.timestamp ?? Math.floor(Date.now() / 1000);
      blockTimes.set(blockNumber, cached);
    }
    return cached;
  };

  /**
   * How many blocks one pass reads.
   *
   * The range used to be "everything since the cursor", which is fine while the
   * indexer keeps up and impossible when it has to start cold: a chain a few
   * hours old holds two hundred thousand logs, and asking for them in one call
   * ended in `read ECONNRESET` — every pass, on the same range, so the cursor
   * never moved and the board never filled. Bounded, a cold start is a few
   * seconds a chunk and the cursor keeps what it has already read.
   */
  const CHUNK = Number(process.env.LOCAL_INDEXER_CHUNK ?? 2_000);

  const sync = async () => {
    const head = await provider.getBlockNumber();
    while (cursor <= head) await syncRange(cursor, Math.min(cursor + CHUNK - 1, head));
  };

  const syncRange = async (from: number, to: number) => {
    // Two phases, because a window's markets are created in the same range as
    // their first orders. Asking for logs from an address list that does not yet
    // contain those markets silently drops every order in the batch — which is
    // exactly the bug `contractRegister` exists to avoid in production, and the
    // same one has to be avoided here.
    //
    // Phase 1: read the factory alone and learn which markets exist.
    const discovery = await provider.getLogs({
      fromBlock: from,
      toBlock: to,
      address: deployment.pitFactory,
    });
    for (const log of discovery) {
      const parsed = factoryIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "WindowCreated") continue;
      markets.add(parsed.args[7]); // yesMarket
      markets.add(parsed.args[8]); // noMarket
    }

    // Phase 2: read everything, in order, and apply it once.
    const logs = await provider.getLogs({
      fromBlock: from,
      toBlock: to,
      address: [deployment.pitFactory, ...markets],
    });

    for (const log of logs) {
      const block = { number: log.blockNumber, timestamp: await timestampOf(log.blockNumber) };

      if (log.address.toLowerCase() === deployment.pitFactory.toLowerCase()) {
        await handleFactoryLog(log, block);
        continue;
      }

      const parsed = bookIface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;

      if (parsed.name === "OrderCreated") {
        await applyOrderCreated(memory.store, {
          market: log.address,
          orderId: parsed.args[0],
          owner: parsed.args[1],
          size: parsed.args[2],
          price: BigInt(parsed.args[3]),
          isBuy: parsed.args[4],
          txHash: log.transactionHash,
          block,
        });
      } else if (parsed.name === "OrdersCanceled") {
        await applyOrdersCanceled(memory.store, {
          market: log.address,
          orderIds: [...parsed.args[0]].map((id: bigint) => BigInt(id)),
          owner: parsed.args[1],
          block,
        });
      } else if (parsed.name === "Trade") {
        await applyTrade(memory.store, {
          market: log.address,
          orderId: parsed.args[0],
          makerAddress: parsed.args[1],
          isBuy: parsed.args[2],
          price: parsed.args[3],
          updatedSize: parsed.args[4],
          takerAddress: parsed.args[5],
          filledSize: parsed.args[7],
          txHash: log.transactionHash,
          logIndex: log.index,
          block,
        });
      }
    }

    // Only after the range is applied: a throw here leaves the cursor where the
    // work actually got to, and the next pass picks up the same chunk rather
    // than the whole history again.
    cursor = to + 1;
  };

  async function handleFactoryLog(log: { topics: readonly string[]; data: string }, block: { number: number; timestamp: number }) {
    const parsed = factoryIface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return;

    if (parsed.name === "WindowCreated") {
      const [windowId, underlying, startTs, endTs, strikeE8, yes, no, yesMarket, noMarket] = parsed.args;

      // Already added during discovery; kept explicit so the intent is local.
      markets.add(yesMarket);
      markets.add(noMarket);

      await applyWindowCreated(memory.store, {
        windowId,
        underlying,
        startTs: BigInt(startTs),
        endTs: BigInt(endTs),
        strikeE8,
        yes,
        no,
        yesMarket,
        noMarket,
        block,
      });

      const at = new Date(Number(endTs) * 1000).toISOString().slice(11, 16);
      console.log(`  window ${windowId} @ ${at} strike ${(Number(strikeE8) / 1e8).toFixed(0)}`);
    }

    if (parsed.name === "WindowSettled" || parsed.name === "WindowVoided") {
      const windowId = parsed.args[0];
      const voided = parsed.name === "WindowVoided";
      const outcome = voided ? OUTCOME.Void : Number(parsed.args[1]);
      await applyWindowResolved(memory.store, {
        windowId,
        outcome,
        settlePriceE8: voided ? 0n : parsed.args[2],
        settledAt: BigInt(voided ? parsed.args[1] : parsed.args[3]),
        block,
      });
      console.log(`  window ${windowId} -> ${["", "YES", "NO", "VOID"][outcome]}`);
    }

    if (parsed.name === "SetMinted" || parsed.name === "SetBurned" || parsed.name === "Redeemed") {
      const sign = parsed.name === "SetMinted" ? 1n : -1n;
      await applyCollateralDelta(memory.store, parsed.args[0], sign * (parsed.args[2] as bigint));
    }
  }

  /**
   * One sync at a time.
   *
   * `setInterval` fires on the clock, not on completion, and the cursor only
   * moves once a range has been applied — so a pass that outlasts the interval
   * had the next one start on the same blocks and apply the same logs again. The
   * roller quotes about a hundred and eighty books a tick, which is a burst that
   * takes seconds to read, so passes stacked several deep.
   *
   * `applyOrdersCanceled` ignores an order it has already closed, and
   * `applyOrderCreated` did not have the matching guard, so every replay added
   * the order's size to its level and never took it off: one book here was
   * holding a hundred and fifty-one copies of the same resting order against
   * forty-seven events on the chain, with three generations of quote crossing
   * each other. The fold is idempotent now and this cannot cause it — but a
   * dev harness reading the same blocks twice is wrong on its own terms.
   *
   * Scheduled after the work instead of alongside it: a slow pass delays the
   * next one rather than racing it.
   */
  const loop = async () => {
    try {
      await sync();
    } catch (error) {
      console.error("sync:", (error as Error).message);
    }
    setTimeout(() => void loop(), POLL_MS);
  };

  await loop();

  http
    .createServer((request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "content-type");
      if (request.method === "OPTIONS") return response.writeHead(204).end();

      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        try {
          const { query, variables } = JSON.parse(body || "{}");
          const data = resolve(memory, String(query), variables ?? {});
          response.writeHead(200, { "content-type": "application/json" });
          response.end(json({ data }));
        } catch (error) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(json({ errors: [{ message: (error as Error).message }] }));
        }
      });
    })
    .listen(PORT, () => {
      console.log(`GraphQL on http://localhost:${PORT}/v1/graphql`);
      console.log(`Point the app at it: NEXT_PUBLIC_INDEXER_URL=http://localhost:${PORT}/v1/graphql`);
    });
}

/** BigInts leave as strings, which is what Hasura's `numeric` does too. */
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/**
 * Understands the four documents this app sends, dispatched by operation name.
 * A real GraphQL server this is not; it does not need to be.
 */
function resolve(memory: ReturnType<typeof createMemoryStore>, query: string, variables: Record<string, string>) {
  const name = /query\s+(\w+)/.exec(query)?.[1];

  if (name === "Grid") {
    const from = BigInt(variables.endTsFrom ?? "0");
    const to = BigInt(variables.endTsTo ?? "0");
    return {
      CellState: memory
        .rows<{ endTs: bigint; strikeE8: bigint }>("CellState")
        .filter((row) => row.endTs >= from && row.endTs <= to)
        .sort((a, b) => Number(a.endTs - b.endTs) || Number(b.strikeE8 - a.strikeE8)),
    };
  }

  if (name === "Cell") {
    const market = (variables.market ?? "").toLowerCase();
    const since = BigInt(variables.since ?? "0");
    const live = <T>(table: string) =>
      memory.rows<T & { market_id: string }>(table).filter((row) => row.market_id === market);

    return {
      CellState: memory.rows<{ id: string }>("CellState").filter((row) => row.id === market),
      bids: live<{ isBuy: boolean; size: bigint; price: bigint }>("BookLevel")
        .filter((row) => row.isBuy && row.size > 0n)
        .sort((a, b) => Number(b.price - a.price))
        .slice(0, 12),
      asks: live<{ isBuy: boolean; size: bigint; price: bigint }>("BookLevel")
        .filter((row) => !row.isBuy && row.size > 0n)
        .sort((a, b) => Number(a.price - b.price))
        .slice(0, 12),
      fills: live<{ timestamp: bigint }>("Fill")
        .sort((a, b) => Number(b.timestamp - a.timestamp))
        .slice(0, 40),
      flow: live<{ bucketTs: bigint }>("WindowCvd")
        .filter((row) => row.bucketTs >= since)
        .sort((a, b) => Number(a.bucketTs - b.bucketTs)),
      liveMakers: live<{ liveOrders: number; restingSize: bigint }>("MarketMaker")
        .filter((row) => row.liveOrders > 0)
        .sort((a, b) => Number(b.restingSize - a.restingSize))
        .slice(0, 8),
    };
  }

  if (name === "MyOrders") {
    const owner = (variables.owner ?? "").toLowerCase();
    const market = (variables.market ?? "").toLowerCase();
    return {
      Order: memory
        .rows<{ owner: string; market_id: string; status: string; price: bigint }>("Order")
        .filter((row) => row.owner === owner && row.market_id === market && row.status === "open")
        .sort((a, b) => Number(b.price - a.price)),
    };
  }

  if (name === "Window") {
    return { Window: memory.rows<{ id: string }>("Window").filter((row) => row.id === variables.windowId) };
  }

  throw new Error(`local-indexer does not implement query "${name ?? "?"}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
