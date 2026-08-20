import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  images: { remotePatterns: [{ protocol: "https", hostname: "coin-images.coingecko.com" }] },
};

export default nextConfig;
