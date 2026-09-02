import "@nomicfoundation/hardhat-toolbox";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import type { HardhatUserConfig } from "hardhat/config";

// One .env at the repo root feeds contracts, indexer and CRE.
loadEnv({ path: path.resolve(__dirname, "../../.env") });

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // Pit windows are timestamp-driven; tests move the clock explicitly.
      allowBlocksWithSameTimestamp: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    monadTestnet: {
      url: process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
    monadMainnet: {
      url: process.env.MONAD_MAINNET_RPC_URL ?? "https://rpc.monad.xyz",
      chainId: Number(process.env.MONAD_MAINNET_CHAIN_ID ?? 143),
      accounts,
    },
  },
  etherscan: {
    apiKey: {
      monadTestnet: process.env.MONAD_EXPLORER_API_KEY ?? "not-required",
    },
    customChains: [
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://testnet.monadexplorer.com/api",
          browserURL: "https://testnet.monadexplorer.com",
        },
      },
    ],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
