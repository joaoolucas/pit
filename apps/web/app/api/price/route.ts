import { NextResponse } from "next/server";

/**
 * Reference spot, proxied.
 *
 * The browser cannot call Coinbase directly without CORS grief, and more
 * importantly: the seeding script, the CRE workflow and this endpoint must all
 * read the same source, or the price a trader sees will not be the price the
 * window settles on. One constant, three consumers.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPOT = (pair: string) => `https://api.coinbase.com/v2/prices/${pair}/spot`;

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair") ?? "BTC-USD";
  if (!/^[A-Z]{2,6}-[A-Z]{3,5}$/.test(pair)) {
    return NextResponse.json({ error: "bad pair" }, { status: 400 });
  }

  try {
    const response = await fetch(SPOT(pair), { next: { revalidate: 1 } });
    if (!response.ok) throw new Error(`upstream ${response.status}`);

    const body = (await response.json()) as { data?: { amount?: string } };
    const amount = body.data?.amount;
    if (!amount) throw new Error("no amount in payload");

    return NextResponse.json({
      pair,
      amount,
      // The same 1e8 scale CellFactory stores strikes in, so the UI never has to
      // guess whether a number has been scaled yet.
      priceE8: (BigInt(Math.round(Number(amount) * 1e8))).toString(),
      at: Date.now(),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
