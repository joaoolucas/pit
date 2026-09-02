"use client";

import { useEffect, useState } from "react";

import { PRICE_POLL_MS } from "./config";

export type Candle = { time: number; low: number; high: number; open: number; close: number };

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

/** One-minute candles, refreshed slowly — this is the context line, not a feed. */
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
