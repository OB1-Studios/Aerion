import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// Local development keeps one .env at the repo root; deployed containers get real environment
// variables (and the standalone server never loads this file).
const rootEnv = new URL("../../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  output: "standalone",
  // Internal packages ship TypeScript source.
  transpilePackages: ["@ebo/ai", "@ebo/core", "@ebo/db", "@ebo/engine", "@ebo/vultr"],
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "unpdf"],
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  poweredByHeader: false,
  // Two build workers keep `next build` within a laptop's memory (and the 2-vCPU VM's).
  experimental: {
    cpus: 2,
    // Uploads arrive through a server action: up to 25 MB a request (code limits each file to 10 MB).
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default config;
