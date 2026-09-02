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
