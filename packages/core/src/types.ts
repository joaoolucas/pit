import type { Underlying } from "./windows";

export enum Outcome {
  Unresolved = 0,
  Yes = 1,
  No = 2,
  Void = 3,
}

export type Side = "yes" | "no";

/** A window as the contract stores it, decoded for the UI. */
export type CellWindow = {
  windowId: number;
  underlying: Underlying;
  startTs: number;
  endTs: number;
  strikeE8: bigint;
  yes: `0x${string}`;
  no: `0x${string}`;
  yesMarket: `0x${string}`;
  noMarket: `0x${string}`;
  collateral: bigint;
  outcome: Outcome;
  settlePriceE8: bigint;
  settledAt: number;
};

/** One aggregated price level, as the indexer derives it from Kuru's logs. */
export type BookLevel = {
  /** Kuru tick. Divide by PRICE_PRECISION for a probability. */
  price: bigint;
  /** Kuru size, summed across resting orders at this price. */
  size: bigint;
  orderCount: number;
};

export type Book = {
  market: `0x${string}`;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Block the indexer had processed when this book was read. */
  blockNumber: number;
};

export type Fill = {
  id: string;
  market: `0x${string}`;
  orderId: number;
  maker: `0x${string}`;
  taker: `0x${string}`;
  /** True when the resting order that got hit was a bid, i.e. the taker sold. */
  makerIsBuy: boolean;
  price: bigint;
  filledSize: bigint;
  blockNumber: number;
  timestamp: number;
  txHash: `0x${string}`;
};

export type RestingOrder = {
  id: string;
  market: `0x${string}`;
  orderId: number;
  owner: `0x${string}`;
  isBuy: boolean;
  price: bigint;
  size: bigint;
  remainingSize: bigint;
  status: "open" | "filled" | "canceled";
  blockNumber: number;
  timestamp: number;
};

/** Cumulative volume delta over a window, signed by taker aggression. */
export type WindowCvdPoint = {
  bucketTs: number;
  cvd: bigint;
  volume: bigint;
  trades: number;
};

/** Everything the grid needs to paint one cell. */
export type CellState = {
  windowId: number;
  underlying: Underlying;
  endTs: number;
  strikeE8: bigint;
  side: Side;
  market: `0x${string}`;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  lastPrice: bigint | null;
  volume: bigint;
  openInterest: bigint;
  makers: number;
  outcome: Outcome;
};
