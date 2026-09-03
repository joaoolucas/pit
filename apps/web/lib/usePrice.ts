"use client";

import { useEffect, useState } from "react";

import { PRICE_POLL_MS } from "./config";

export type Candle = { time: number; low: number; high: number; open: number; close: number };
/** One reading of spot, at the second it arrived. */
export type PricePoint = { t: number; usd: number };

/** Spot, on the same 1e8 scale the contracts use. */
export function useSpot(pair = "BTC-USD") {
  const [priceE8, setPriceE8] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const response = await fetch(`/api/price?pair=${pair}`);
        if (!response.ok) throw new Error(`${response.status}`);
        const body = (await response.json()) as { priceE8: string };
        if (!cancelled) {
          setPriceE8(BigInt(body.priceE8));
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    };

    void read();
    const id = setInterval(read, PRICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pair]);

  return { priceE8, error };
}

/**
 * The last stretch of spot, kept as it arrives.
 *
 * The candle feed is one point a minute and runs a couple of minutes behind, so
 * the newest part of the line — the part drawn over the window actually being
 * traded — was a single straight segment between two stale readings. Spot lands
 * every second. Kept, it gives that stretch a shape, which is the difference
 * between a chart that updates and a chart that is live. How much of that shape
 * is worth drawing is the board's decision, not this one's: see `points` in
 * Trace, which thins it to something a pixel can hold.
 *
 * Bounded by time rather than by count, so a tab left open overnight holds the
 * same few minutes as one just opened.
 */
export function useSpotTrail(priceE8: bigint | null, keepSeconds = 15 * 60) {
  const [trail, setTrail] = useState<PricePoint[]>([]);

  useEffect(() => {
    if (priceE8 === null) return;
    const usd = Number(priceE8) / 1e8;
    const at = Date.now() / 1000;

    setTrail((previous) => {
      const last = previous[previous.length - 1];
      // Two readings inside the same second say nothing the first did not.
      if (last && last.usd === usd && at - last.t < 1) return previous;

      const next = [...previous, { t: at, usd }];
      const cut = at - keepSeconds;
      const first = next.findIndex((point) => point.t >= cut);
      return first > 0 ? next.slice(first) : next;
    });
  }, [priceE8, keepSeconds]);

  return trail;
}

/** One-minute candles, refreshed slowly — the older half of the same line. */
export function useCandles(pair = "BTC-USD") {
  const [candles, setCandles] = useState<Candle[]>([]);

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        const response = await fetch(`/api/candles?pair=${pair}`);
        if (!response.ok) return;
        const body = (await response.json()) as { candles: Candle[] };
        if (!cancelled) setCandles(body.candles ?? []);
      } catch {
        // The line is decoration for the grid; its absence must not break it.
      }
    };

    void read();
    const id = setInterval(read, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pair]);

  return candles;
}

/** A one-second clock, so every countdown on the page ticks together. */
export function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
