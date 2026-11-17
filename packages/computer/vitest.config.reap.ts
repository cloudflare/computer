// Workerd-backed runner for the reaping end-to-end tests: a real
// Workspace in a SQLite-backed Durable Object, driven over RPC.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.reap.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/reap.test.ts"],
    testTimeout: 120_000,
  },
});
