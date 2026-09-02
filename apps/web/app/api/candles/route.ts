import { NextResponse } from "next/server";

/**
 * One-minute candles for the price line drawn across the grid.
 *
 * The line is context, not a trading signal, so a minute of granularity is
 * plenty and a short cache keeps a demo from rate-limiting itself.
 */
export const runtime = "nodejs";
export const revalidate = 15;

const CANDLES = (pair: string) =>
  `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=60`;

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair") ?? "BTC-USD";
  if (!/^[A-Z]{2,6}-[A-Z]{3,5}$/.test(pair)) {
    return NextResponse.json({ error: "bad pair" }, { status: 400 });
  }

  try {
    const response = await fetch(CANDLES(pair), { next: { revalidate: 15 } });
    if (!response.ok) throw new Error(`upstream ${response.status}`);

    // [ time, low, high, open, close, volume ], newest first.
    const raw = (await response.json()) as number[][];
    const candles = raw
      .slice(0, 120)
      .reverse()
      .map(([time, low, high, open, close]) => ({ time, low, high, open, close }));

    return NextResponse.json({ pair, candles });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
