import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    preloadEntriesOnStart: false,
  },
  deploymentId: process.env.DEPLOYMENT_VERSION,
};

export default nextConfig;
