# Ops image: GraphQL indexer + tick loop against Monad testnet.
# Build context is the repo root (see railway.toml).
FROM node:22-bookworm-slim

WORKDIR /app

COPY packages/contracts/package.json packages/contracts/package-lock.json ./packages/contracts/
WORKDIR /app/packages/contracts
RUN npm ci

WORKDIR /app
COPY packages/core ./packages/core
COPY packages/indexer/src ./packages/indexer/src
COPY packages/contracts ./packages/contracts

WORKDIR /app/packages/contracts
RUN npx hardhat compile

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "scripts/start-ops.mjs"]
