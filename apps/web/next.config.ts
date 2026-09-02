import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A production build and a dev server cannot share one output directory: run
  // `npm run build` while `npm run dev` is up and dev starts serving half-built
  // production chunks and 500s on every route. Giving them separate homes makes
  // that impossible rather than merely documented.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // @cell/core is TypeScript source, shared with the deploy scripts and the
  // indexer so a cell is defined once. Next has to compile it rather than
  // expect a build step.
  transpilePackages: ["@cell/core"],
};

export default nextConfig;
