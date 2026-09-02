"use client";

import { BigNumber, ethers } from "ethers";
import { useEffect, useState } from "react";

import { collateralAddress, isConfigured } from "./config";
import { erc20 } from "./kuru";
import { readProvider } from "./wallet";

export type CollateralInfo = {
  address: string;
  symbol: string;
  decimals: number;
  balance: BigNumber | null;
};

/**
 * The quote asset for every market, read once from the chain rather than
 * hard-coded — a mainnet deployment points at real USDC and a testnet one at the
 * faucet token, and the ticket must show the right symbol either way.
 */
export function useCollateral(owner: string | null): CollateralInfo {
  const [info, setInfo] = useState<CollateralInfo>({
    address: collateralAddress,
    symbol: "",
    decimals: 6,
    balance: null,
  });

  useEffect(() => {
    if (!isConfigured) return;
    let cancelled = false;
    const provider = readProvider();
    const token = erc20(collateralAddress, provider);

    const read = async () => {
      try {
        const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
        const balance = owner ? ((await token.balanceOf(owner)) as BigNumber) : null;
        if (!cancelled) {
          setInfo({ address: collateralAddress, symbol, decimals: Number(decimals), balance });
        }
      } catch {
        // A misconfigured address should not blank the whole ticket; the caller
        // still gets sane defaults and the header already flags the config.
      }
    };

    void read();
    const id = setInterval(read, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [owner]);

  return info;
}

export const formatUnits = (value: BigNumber | null, decimals: number, places = 2) =>
  value === null ? "—" : Number(ethers.utils.formatUnits(value, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: places,
  });
