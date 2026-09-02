import { chainById, type ChainConfig } from "@pit/core";

/**
 * Runtime configuration, read once.
 *
 * Everything here comes from NEXT_PUBLIC_* so a deployment can be repointed at a
 * different PitFactory without a rebuild of anything but the env.
 */

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

export const chain: ChainConfig = {
  ...chainById(chainId),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || chainById(chainId).rpcUrl,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || chainById(chainId).explorerUrl,
};

export const pitFactoryAddress = (process.env.NEXT_PUBLIC_PIT_FACTORY ?? "") as `0x${string}`;
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

export const isConfigured = Boolean(pitFactoryAddress && collateralAddress);

/**
 * The command that keeps the next columns open, for the chain this build points at.
 *
 * Two things this has to get right. `tick` targets Monad testnet and
 * `tick:local` a local node, so naming the wrong one sends transactions to a
 * public network that will not fill the board in front of you. And the roller is
 * an operating loop, not a one-shot: a single pass buys five minutes and then
 * the board empties again, so what belongs here is the watcher.
 */
export const rollCommand =
  chain.id === 31337
    ? "TICK_WATCH=1 npm --prefix packages/contracts run tick:local"
    : "TICK_WATCH=1 npm --prefix packages/contracts run tick";
