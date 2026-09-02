import { chainById, type ChainConfig } from "@cell/core";

/**
 * Runtime configuration, read once.
 *
 * Everything here comes from NEXT_PUBLIC_* so a deployment can be repointed at a
 * different CellFactory without a rebuild of anything but the env.
 */

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

export const chain: ChainConfig = {
  ...chainById(chainId),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || chainById(chainId).rpcUrl,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || chainById(chainId).explorerUrl,
};

export const cellFactoryAddress = (process.env.NEXT_PUBLIC_CELL_FACTORY ?? "") as `0x${string}`;
export const collateralAddress = (process.env.NEXT_PUBLIC_COLLATERAL ?? "") as `0x${string}`;

export const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8080/v1/graphql";

/** Relying-party id for the passkey. Must equal the host, with no scheme or port. */
export const passkeyRpId = process.env.NEXT_PUBLIC_PASSKEY_RP_ID ?? "localhost";

export const UNDERLYING = "BTC-USD" as const;

/** How often the grid re-reads the indexer. Monad blocks are 400ms; this is the
 *  slowest poll that still feels live, and it keeps a browser tab honest. */
export const GRID_POLL_MS = 1200;
export const CELL_POLL_MS = 700;
export const PRICE_POLL_MS = 3000;

export const isConfigured = Boolean(cellFactoryAddress && collateralAddress);
