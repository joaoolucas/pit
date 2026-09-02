/** Networks Pit knows about, and the Kuru deployment on each. */

export type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  kuru: {
    router: `0x${string}`;
    marginAccount: `0x${string}`;
    kuruUtils?: `0x${string}`;
  };
};

/**
 * Addresses taken from docs.kuru.io/contracts/Contract-addresses.
 * Re-check these before a mainnet deploy; they are the one thing in this repo
 * that is not verifiable from the source tree.
 */
export const MONAD_TESTNET: ChainConfig = {
  id: 10143,
  name: "Monad Testnet",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadexplorer.com",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  kuru: {
    router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02",
    kuruUtils: "0xE0841E0F06c5770C1D4930EC6C507ee33199C88C",
  },
};

export const MONAD_MAINNET: ChainConfig = {
  id: 143,
  name: "Monad",
  rpcUrl: "https://rpc.monad.xyz",
  explorerUrl: "https://monadexplorer.com",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  kuru: {
    router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
    marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
  },
};

/**
 * A Hardhat node with MockKuruRouter standing in for Kuru.
 *
 * Present so `npm run dev` works end to end on a laptop with nothing deployed.
 * The Kuru addresses are filled in at deploy time — on this chain the deploy
 * script deploys its own mock router, so whatever is here would be wrong.
 */
export const LOCALHOST: ChainConfig = {
  id: 31337,
  name: "Hardhat",
  rpcUrl: "http://127.0.0.1:8545",
  explorerUrl: "http://127.0.0.1:8545",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  kuru: {
    router: "0x0000000000000000000000000000000000000000",
    marginAccount: "0x0000000000000000000000000000000000000000",
  },
};

export const CHAINS: Record<number, ChainConfig> = {
  [MONAD_TESTNET.id]: MONAD_TESTNET,
  [MONAD_MAINNET.id]: MONAD_MAINNET,
  [LOCALHOST.id]: LOCALHOST,
};

export function chainById(id: number): ChainConfig {
  const chain = CHAINS[id];
  if (!chain) throw new Error(`Unknown chain id ${id}. Add it to packages/core/src/chain.ts.`);
  return chain;
}

export function txUrl(chain: ChainConfig, hash: string): string {
  return `${chain.explorerUrl}/tx/${hash}`;
}

export function addressUrl(chain: ChainConfig, address: string): string {
  return `${chain.explorerUrl}/address/${address}`;
}

export function shortAddress(address: string, size = 4): string {
  if (!address?.startsWith("0x") || address.length < 2 * size + 2) return address ?? "";
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}
