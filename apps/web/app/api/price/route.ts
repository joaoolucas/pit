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

type Reading = { pair: string; amount: string; priceE8: string; at: number };

/**
 * The last reading, held here rather than in the fetch cache.
 *
 * `revalidate: 1` looked like the same thing and is not. Next serves the stale
 * entry while it refreshes, so consecutive polls came back 81123 → 81141 →
 * 81123 → 81145: the feed went backwards in time, once a second, between two
 * values it already had. At a three-second poll that mostly hid inside the gaps.
 * Drawn as a live line at one second it is a sawtooth, and the chart reports
 * twenty dollars of movement BTC never made.
 *
 * Held explicitly, a reading is either fresh enough to serve or worth waiting
 * for, and it never goes backwards. `inflight` means a burst of clients costs
 * the upstream one call, not one each.
 */
const MAX_AGE_MS = 800;
let last: Reading | null = null;
let inflight: { pair: string; reading: Promise<Reading> } | null = null;

async function read(pair: string): Promise<Reading> {
  const response = await fetch(SPOT(pair), { cache: "no-store" });
  if (!response.ok) throw new Error(`upstream ${response.status}`);

  const body = (await response.json()) as { data?: { amount?: string } };
  const amount = body.data?.amount;
  if (!amount) throw new Error("no amount in payload");

  return {
    pair,
    amount,
    // The same 1e8 scale PitFactory stores strikes in, so the UI never has to
    // guess whether a number has been scaled yet.
    priceE8: BigInt(Math.round(Number(amount) * 1e8)).toString(),
    at: Date.now(),
  };
}

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair") ?? "BTC-USD";
  if (!/^[A-Z]{2,6}-[A-Z]{3,5}$/.test(pair)) {
    return NextResponse.json({ error: "bad pair" }, { status: 400 });
  }

  if (last && last.pair === pair && Date.now() - last.at < MAX_AGE_MS) {
    return NextResponse.json(last);
  }

  try {
    if (inflight?.pair !== pair) {
      inflight = {
        pair,
        reading: read(pair).finally(() => {
          inflight = null;
        }),
      };
    }
    last = await inflight.reading;
    return NextResponse.json(last);
  } catch (error) {
    // A blip upstream should not blank the line: the last good reading is a
    // better answer than none, right up until it is old enough to mislead.
    if (last && last.pair === pair && Date.now() - last.at < 30_000) {
      return NextResponse.json(last);
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
