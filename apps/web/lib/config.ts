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
 * The command that opens the next columns, for the chain this build points at.
 *
 * The empty state used to name `tick` unconditionally, and `tick` targets Monad
 * testnet — so anyone running the board against a local Hardhat node was told to
 * send transactions to a public network that would not fill the board in front
 * of them. The app knows which chain it is on; it may as well say the right
 * thing.
 */
export const rollCommand =
  chain.id === 31337
    ? "npm --prefix packages/contracts run tick:local"
    : "npm --prefix packages/contracts run tick";
