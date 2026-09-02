"use client";

import { ethers } from "ethers";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { chain } from "./config";

/**
 * A normal Monad wallet, and nothing clever.
 *
 * Signing is deliberately boring: an injected EIP-1193 provider through ethers
 * v5, which is what the Kuru SDK speaks. The passkey in this app encrypts notes
 * (see lib/notes.ts) and is never a key that can move funds — the two are kept
 * in separate files so that stays obvious.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

type WalletState = {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  available: boolean;
  onRightChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  getSigner: () => ethers.Signer;
};

const WalletContext = createContext<WalletState | null>(null);

const toHexChainId = (id: number) => `0x${id.toString(16)}`;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const injected = window.ethereum;
    setAvailable(Boolean(injected));
    if (!injected) return;

    // Reconnect silently if the site is already authorised — a trader should not
    // have to click connect every reload.
    void (async () => {
      try {
        const accounts = (await injected.request({ method: "eth_accounts" })) as string[];
        if (accounts?.[0]) setAddress(accounts[0]);
        const hex = (await injected.request({ method: "eth_chainId" })) as string;
        setChainId(Number.parseInt(hex, 16));
      } catch {
        // A provider that refuses eth_accounts is simply not connected.
      }
    })();

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts?.[0] ?? null);
    };
    const onChain = (...args: never[]) => {
      const hex = args[0] as unknown as string;
      setChainId(Number.parseInt(hex, 16));
    };

    injected.on?.("accountsChanged", onAccounts);
    injected.on?.("chainChanged", onChain);
    return () => {
      injected.removeListener?.("accountsChanged", onAccounts);
      injected.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const injected = window.ethereum;
    if (!injected) {
      setError("No Monad wallet found in this browser.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      setAddress(accounts?.[0] ?? null);
      const hex = (await injected.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(hex, 16));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    const injected = window.ethereum;
    if (!injected) return;
    try {
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHexChainId(chain.id) }],
      });
    } catch (cause) {
      // 4902: the wallet has never heard of this chain. Offer to add it.
      if ((cause as { code?: number }).code === 4902) {
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: toHexChainId(chain.id),
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.explorerUrl],
            },
          ],
        });
      } else {
        setError((cause as Error).message);
      }
    }
  }, []);

  const getSigner = useCallback(() => {
    const injected = window.ethereum;
    if (!injected) throw new Error("No wallet connected.");
    // ethers v5 on purpose: it is what @kuru-labs/kuru-sdk expects.
    const provider = new ethers.providers.Web3Provider(injected as never, "any");
    return provider.getSigner();
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      chainId,
      connecting,
      error,
      available,
      onRightChain: chainId === chain.id,
      connect,
      disconnect: () => setAddress(null),
      switchChain,
      getSigner,
    }),
    [address, chainId, connecting, error, available, connect, switchChain, getSigner],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside <WalletProvider>");
  return context;
}

/** A read-only provider for view calls that must work before anyone connects. */
export function readProvider() {
  return new ethers.providers.JsonRpcProvider(chain.rpcUrl, chain.id);
}
