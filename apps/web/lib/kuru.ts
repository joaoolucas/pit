"use client";

import { BigNumber, ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";

import { pitFactoryAddress } from "./config";
import { pitFactoryAbi } from "@pit/core/abi/pitFactory";
import { erc20Abi } from "@pit/core/abi/erc20";

/**
 * Every order in this app goes through Kuru.
 *
 * There is no internal matching, no off-chain order store, and no "simulated"
 * mode. `placeLimit` below is the Kuru SDK's own `GTC.placeLimit` against the
 * market that `PitFactory.createWindow` listed. If Kuru is down, Pit is down,
 * which is the correct coupling for something claiming to be a CLOB front end.
 *
 * Sizes and prices cross this boundary as human strings — "0.42", "100" — because
 * that is the SDK's contract, and it does the precision scaling from the market's
 * own parameters. Converting to ticks ourselves would be a second source of truth.
 */

export type MarketParams = Awaited<ReturnType<typeof KuruSdk.ParamFetcher.getMarketParams>>;

const paramCache = new Map<string, Promise<MarketParams>>();

/** Market parameters are immutable once listed, so read them once per market. */
export function getMarketParams(
  provider: ethers.providers.Provider,
  market: string,
): Promise<MarketParams> {
  const key = market.toLowerCase();
  let cached = paramCache.get(key);
  if (!cached) {
    cached = KuruSdk.ParamFetcher.getMarketParams(provider as never, market);
    paramCache.set(key, cached);
  }
  return cached;
}

export type LimitOrder = {
  market: string;
  /** Probability as a decimal string, e.g. "0.425". */
  price: string;
  /** Contracts as a decimal string, e.g. "100". */
  size: string;
  isBuy: boolean;
  /** True for a resting quote that must not cross. */
  postOnly: boolean;
};

export async function placeLimit(signer: ethers.Signer, order: LimitOrder) {
  const provider = signer.provider;
  if (!provider) throw new Error("Signer has no provider");

  const marketParams = await getMarketParams(provider, order.market);

  // Kuru pulls the tokens from the trader on fill, so the market needs an
  // allowance on whichever side is being spent: collateral for a bid, the
  // outcome token for an offer.
  const spendToken = order.isBuy ? marketParams.quoteAssetAddress : marketParams.baseAssetAddress;
  await ensureAllowance(signer, spendToken, order.market);

  return KuruSdk.GTC.placeLimit(signer, order.market, marketParams, {
    price: order.price,
    size: order.size,
    isBuy: order.isBuy,
    postOnly: order.postOnly,
  });
}

export async function cancelOrders(signer: ethers.Signer, market: string, orderIds: (string | number)[]) {
  return KuruSdk.OrderCanceler.cancelOrders(
    signer,
    market,
    orderIds.map((id) => BigNumber.from(id)),
  );
}

/** Reads the L2 book straight from the market. Used only as a cross-check. */
export async function readL2Book(provider: ethers.providers.Provider, market: string) {
  const marketParams = await getMarketParams(provider, market);
  return KuruSdk.OrderBook.getL2OrderBook(provider as never, market, marketParams);
}

// ---------------------------------------------------------------------------
// PitFactory: issuance and redemption
// ---------------------------------------------------------------------------

export function pitFactory(signerOrProvider: ethers.Signer | ethers.providers.Provider) {
  return new ethers.Contract(pitFactoryAddress, pitFactoryAbi as never, signerOrProvider);
}

/**
 * Lock collateral, receive one YES and one NO per unit.
 *
 * This is how a trader who wants to *sell* a leg gets something to sell, and it
 * is the same call the seeding script makes. Worth surfacing in the UI rather
 * than hiding: it is the clearest statement that the two legs sum to one.
 */
export async function mintSet(signer: ethers.Signer, windowId: number | string, amount: BigNumber) {
  await ensureAllowance(signer, await collateralOf(signer), pitFactoryAddress, amount);
  const tx = await pitFactory(signer).mintSet(windowId, amount);
  return tx.wait();
}

export async function burnSet(signer: ethers.Signer, windowId: number | string, amount: BigNumber) {
  const tx = await pitFactory(signer).burnSet(windowId, amount);
  return tx.wait();
}

export async function redeem(signer: ethers.Signer, windowId: number | string) {
  const tx = await pitFactory(signer).redeem(windowId);
  return tx.wait();
}

export type ListedWindow = {
  windowId: number;
  yes: string;
  no: string;
  yesMarket: string;
  noMarket: string;
};

/** List a cell if it is missing. The signer pays the two Kuru deploys. */
export async function ensureWindow(
  signer: ethers.Signer,
  args: { underlying: string; startTs: number; endTs: number; strikeE8: bigint },
): Promise<ListedWindow> {
  const factory = pitFactory(signer);
  const underlying = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(args.underlying));
  const found = await factory.findWindow(underlying, args.endTs, args.strikeE8);
  const exists = Boolean(found.exists ?? found[0]);
  const id = found.id ?? found[1];
  if (exists) {
    const w = await factory.getWindow(id);
    return {
      windowId: Number(id),
      yes: w.yes,
      no: w.no,
      yesMarket: w.yesMarket,
      noMarket: w.noMarket,
    };
  }
  const tx = await factory.createWindow(underlying, args.startTs, args.endTs, args.strikeE8);
  const receipt = await tx.wait();
  return parseWindowCreated(receipt);
}

function parseWindowCreated(receipt: ethers.ContractReceipt): ListedWindow {
  const iface = new ethers.utils.Interface(pitFactoryAbi as never);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === "WindowCreated") {
        return {
          windowId: parsed.args.windowId.toNumber(),
          yes: parsed.args.yes,
          no: parsed.args.no,
          yesMarket: parsed.args.yesMarket,
          noMarket: parsed.args.noMarket,
        };
      }
    } catch {
      /* other contracts in the same tx */
    }
  }
  throw new Error("WindowCreated missing from receipt");
}

async function collateralOf(signer: ethers.Signer): Promise<string> {
  return pitFactory(signer).collateralToken();
}

// ---------------------------------------------------------------------------
// ERC20
// ---------------------------------------------------------------------------

export function erc20(token: string, signerOrProvider: ethers.Signer | ethers.providers.Provider) {
  return new ethers.Contract(token, erc20Abi as never, signerOrProvider);
}

/**
 * Approve once, generously, and only when the current allowance is short.
 *
 * An approval prompt in the middle of a five-minute window is a lost trade, so
 * this asks for max once rather than exact-amount every time. The spender is
 * always a market this factory deployed or the factory itself.
 */
export async function ensureAllowance(
  signer: ethers.Signer,
  token: string,
  spender: string,
  needed: BigNumber = ethers.constants.MaxUint256.div(2),
) {
  const owner = await signer.getAddress();
  const contract = erc20(token, signer);
  const allowance: BigNumber = await contract.allowance(owner, spender);
  if (allowance.gte(needed)) return;

  const tx = await contract.approve(spender, ethers.constants.MaxUint256);
  await tx.wait();
}

export async function balanceOf(
  provider: ethers.providers.Provider,
  token: string,
  owner: string,
): Promise<BigNumber> {
  return erc20(token, provider).balanceOf(owner);
}
