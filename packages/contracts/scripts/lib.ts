import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

export const ROOT = path.resolve(__dirname, "../../..");
export const DEPLOYMENTS_DIR = path.resolve(__dirname, "../deployments");

export type Deployment = {
  chainId: number;
  network: string;
  deployedAt: string;
  collateral: string;
  collateralSymbol: string;
  collateralDecimals: number;
  kuruRouter: string;
  cellFactory: string;
  settlementReceiver: string;
  creForwarder: string | null;
  settler: string;
  operator: string;
  startBlock: number;
};

export function deploymentPath(networkName = network.name): string {
  return path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
}

export function readDeployment(networkName = network.name): Deployment {
  const file = deploymentPath(networkName);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment for "${networkName}". Run: npm run deploy:testnet`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
}

export function writeDeployment(deployment: Deployment, networkName = network.name): string {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = deploymentPath(networkName);
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// Reference price
//
// The scripts and the CRE workflow read the same public endpoint, so what the
// maker quotes around and what the workflow settles on cannot silently diverge.
// Coinbase is the reference for the demo; swapping it is one constant.
// ---------------------------------------------------------------------------

export const SPOT_URL = (pair: string) => `https://api.coinbase.com/v2/prices/${pair}/spot`;
export const CANDLES_URL = (pair: string, granularity: number) =>
  `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}`;

export async function fetchSpotE8(pair = "BTC-USD"): Promise<bigint> {
  const res = await fetch(SPOT_URL(pair));
  if (!res.ok) throw new Error(`Spot fetch failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: { amount?: string } };
  const amount = Number(body.data?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Bad spot payload: ${JSON.stringify(body)}`);
  return BigInt(Math.round(amount * 1e8));
}

/**
 * Annualised realised vol from the last hour of 1-minute closes.
 *
 * Used only to seed quotes. If it fails we fall back to a fixed 60%, which for
 * BTC is wide enough to be safe and tight enough to be a real quote.
 */
export async function fetchAnnualisedVol(pair = "BTC-USD"): Promise<number> {
  try {
    const res = await fetch(CANDLES_URL(pair, 60));
    if (!res.ok) throw new Error(`${res.status}`);
    // [ time, low, high, open, close, volume ], newest first.
    const candles = (await res.json()) as number[][];
    const closes = candles
      .slice(0, 60)
      .map((c) => c[4])
      .reverse()
      .filter((c): c is number => Number.isFinite(c) && c > 0);
    if (closes.length < 20) throw new Error("not enough candles");

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i]! / closes[i - 1]!));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    const perMinute = Math.sqrt(variance);
    const annualised = perMinute * Math.sqrt(365 * 24 * 60);
    return Number.isFinite(annualised) && annualised > 0 ? annualised : 0.6;
  } catch (error) {
    console.warn(`Realised vol unavailable (${(error as Error).message}); using 60%.`);
    return 0.6;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return value;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function usd(e8: bigint): string {
  return (Number(e8) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
