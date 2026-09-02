"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { indexerUrl } from "./config";

/**
 * The only data path in the app.
 *
 * Every book, every fill, every cell on the grid comes from the Envio indexer
 * over GraphQL. Nothing here polls an RPC for logs, and there is no fallback
 * that quietly reconstructs a book from `eth_getLogs` when the indexer is down —
 * if the indexer is down the UI says so, because a stale book that looks live is
 * worse than no book.
 */

export class IndexerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerError";
  }
}

export async function query<T>(
  document: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal,
  });

  if (!response.ok) {
    throw new IndexerError(`Indexer returned ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (payload.errors?.length) {
    throw new IndexerError(payload.errors.map((e) => e.message).join("; "));
  }
  if (!payload.data) throw new IndexerError("Indexer returned no data");
  return payload.data;
}

type PollState<T> = {
  data: T | null;
  error: Error | null;
  /** True until the first successful response. Later refreshes never blank the UI. */
  loading: boolean;
  /** Wall-clock ms of the last successful read, for the staleness indicator. */
  updatedAt: number | null;
  refresh: () => void;
};

/**
 * Polls a GraphQL document and keeps the last good result on screen.
 *
 * Deliberately not a subscription: a five-minute market refreshed every second
 * is indistinguishable from a live socket to a human, and a poll degrades
 * gracefully when the indexer restarts, which it will during a demo.
 */
export function usePolledQuery<T>(
  document: string,
  variables: Record<string, unknown>,
  intervalMs: number,
  enabled = true,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const serialised = JSON.stringify(variables, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  const inFlight = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    try {
      const result = await query<T>(document, JSON.parse(serialised), controller.signal);
      if (controller.signal.aborted) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (cause) {
      if (controller.signal.aborted || (cause as Error).name === "AbortError") return;
      setError(cause as Error);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [document, serialised]);

  useEffect(() => {
    if (!enabled) return;
    void run();
    const id = setInterval(() => void run(), intervalMs);
    return () => {
      clearInterval(id);
      inFlight.current?.abort();
    };
  }, [run, intervalMs, enabled, tick]);

  return { data, error, loading, updatedAt, refresh: () => setTick((n) => n + 1) };
}

// ---------------------------------------------------------------------------
// Documents — mirrored in packages/indexer/queries/*.graphql, which is the
// readable copy. Kept inline here so there is no loader in the build.
// ---------------------------------------------------------------------------

export const GRID_QUERY = /* GraphQL */ `
  query Grid($endTsFrom: numeric!, $endTsTo: numeric!, $underlying: String!) {
    CellState(
      where: { endTs: { _gte: $endTsFrom, _lte: $endTsTo }, underlying: { _eq: $underlying } }
      order_by: [{ endTs: asc }, { strikeE8: desc }]
    ) {
      id
      windowId
      window_id
      side
      endTs
      strikeE8
      bestBid
      bestAsk
      lastPrice
      bidDepth
      askDepth
      makers
      volume
      tradeCount
      cvd
      outcome
      updatedAtTs
    }
  }
`;

export const CELL_QUERY = /* GraphQL */ `
  query Cell($market: String!, $since: numeric!) {
    CellState(where: { id: { _eq: $market } }) {
      id
      windowId
      window_id
      side
      endTs
      strikeE8
      bestBid
      bestAsk
      lastPrice
      makers
      volume
      tradeCount
      cvd
      outcome
      updatedAtTs
    }
    bids: BookLevel(
      where: { market_id: { _eq: $market }, isBuy: { _eq: true }, size: { _gt: 0 } }
      order_by: { price: desc }
      limit: 12
    ) {
      price
      size
      orderCount
    }
    asks: BookLevel(
      where: { market_id: { _eq: $market }, isBuy: { _eq: false }, size: { _gt: 0 } }
      order_by: { price: asc }
      limit: 12
    ) {
      price
      size
      orderCount
    }
    fills: Fill(where: { market_id: { _eq: $market } }, order_by: { timestamp: desc }, limit: 40) {
      id
      price
      filledSize
      makerIsBuy
      maker
      taker
      timestamp
      txHash
    }
    flow: WindowCvd(
      where: { market_id: { _eq: $market }, bucketTs: { _gte: $since } }
      order_by: { bucketTs: asc }
    ) {
      bucketTs
      cvd
      delta
    }
    liveMakers: MarketMaker(
      where: { market_id: { _eq: $market }, liveOrders: { _gt: 0 } }
      order_by: { restingSize: desc }
      limit: 8
    ) {
      owner
      liveOrders
      restingSize
    }
  }
`;

export const MY_ORDERS_QUERY = /* GraphQL */ `
  query MyOrders($owner: String!, $market: String!) {
    Order(
      where: { owner: { _eq: $owner }, market_id: { _eq: $market }, status: { _eq: "open" } }
      order_by: { price: desc }
    ) {
      id
      orderId
      isBuy
      price
      remainingSize
    }
  }
`;

export const WINDOW_QUERY = /* GraphQL */ `
  query Window($windowId: String!) {
    Window(where: { id: { _eq: $windowId } }) {
      id
      windowId
      endTs
      strikeE8
      yesToken
      noToken
      yesMarket
      noMarket
      collateral
      outcome
      settlePriceE8
      settledAt
    }
  }
`;

// ---------------------------------------------------------------------------
// Response shapes. The indexer returns numerics as strings; parse at the edge so
// nothing downstream has to wonder.
// ---------------------------------------------------------------------------

export type RawCellState = {
  id: string;
  windowId: string;
  window_id: string;
  side: "YES" | "NO";
  endTs: string;
  strikeE8: string;
  bestBid: string | null;
  bestAsk: string | null;
  lastPrice: string | null;
  bidDepth: string;
  askDepth: string;
  makers: number;
  volume: string;
  tradeCount: number;
  cvd: string;
  outcome: number;
  updatedAtTs: string;
};

export type RawLevel = { price: string; size: string; orderCount: number };
export type RawFill = {
  id: string;
  price: string;
  filledSize: string;
  makerIsBuy: boolean;
  maker: string;
  taker: string;
  timestamp: string;
  txHash: string;
};
export type RawFlow = { bucketTs: string; cvd: string; delta: string };
export type RawMaker = { owner: string; liveOrders: number; restingSize: string };
export type RawOrder = {
  id: string;
  orderId: string;
  isBuy: boolean;
  price: string;
  remainingSize: string;
};
export type RawWindow = {
  id: string;
  windowId: string;
  endTs: string;
  strikeE8: string;
  yesToken: string;
  noToken: string;
  yesMarket: string;
  noMarket: string;
  collateral: string;
  outcome: number;
  settlePriceE8: string;
  settledAt: string;
};

export const big = (value: string | null | undefined): bigint | null =>
  value === null || value === undefined ? null : BigInt(value);
