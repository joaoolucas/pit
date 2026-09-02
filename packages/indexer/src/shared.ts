/** Ids and small helpers shared by the two handler files. */

export const CVD_BUCKET_SECONDS = 15n;

export const lower = (address: string) => address.toLowerCase();

export const marketId = (address: string) => lower(address);
export const windowIdOf = (windowId: bigint) => windowId.toString();
export const orderKey = (market: string, orderId: bigint) => `${lower(market)}-${orderId}`;
export const levelKey = (market: string, isBuy: boolean, price: bigint) =>
  `${lower(market)}-${isBuy ? "bid" : "ask"}-${price}`;
export const makerKey = (market: string, owner: string) => `${lower(market)}-${lower(owner)}`;
export const cvdKey = (market: string, bucketTs: bigint) => `${lower(market)}-${bucketTs}`;
export const fillKey = (txHash: string, logIndex: number) => `${txHash}-${logIndex}`;

export const bucketOf = (timestamp: bigint) => (timestamp / CVD_BUCKET_SECONDS) * CVD_BUCKET_SECONDS;

export const OUTCOME = {
  Unresolved: 0,
  Yes: 1,
  No: 2,
  Void: 3,
} as const;

/**
 * Underlying labels, keyed by the keccak256 the contract stores.
 *
 * PitFactory takes a bytes32 so a new pair costs nothing onchain, but the grid
 * filters on a human label. Doing the lookup here means the UI never has to hash
 * anything, and an unknown pair still indexes — it just shows as its hash.
 *
 * Regenerate with:  node -e "console.log(require('ethers').id('BTC-USD'))"
 */
export const UNDERLYING_LABELS: Record<string, string> = {
  "0xb39c402b9bd8428ba7a4cc2d1aca1432756cddeb60941a9175541a819095269e": "BTC-USD",
  "0x2430f68ea2e8d4151992bb7fc3a4c472087a6149bf7e0232704396162ab7c1f7": "ETH-USD",
  "0xc8f26e6a5357088b86b9152126f5617eacfdd451083ac8200098aa83564c11f5": "SOL-USD",
};

export function underlyingLabel(hash: string): string {
  return UNDERLYING_LABELS[hash.toLowerCase()] ?? hash;
}
