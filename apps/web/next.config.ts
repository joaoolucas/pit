import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @cell/core is TypeScript source, shared with the deploy scripts and the
  // indexer so a cell is defined once. Next has to compile it rather than
  // expect a build step.
  transpilePackages: ["@cell/core"],
};

export default nextConfig;
