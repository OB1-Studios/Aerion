import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/worker/test/**/*.test.ts", "infra/test/**/*.test.ts"],
    environment: "node",
    // Most of these run whole workflows against one shared Postgres, so under parallel files
    // they wait on disk: 300 ms alone can pass 5 s when another file creates a database.
    testTimeout: 30_000,
    // Setup and cleanup seed workspaces and drop databases, which wait on the same disk.
    hookTimeout: 60_000,
  },
});
