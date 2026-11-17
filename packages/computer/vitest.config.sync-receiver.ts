// Workerd-backed runner for the rpc push receiver in a SQLite-backed
// Durable Object.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.sync-receiver.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/sync-receiver.test.ts"],
  },
});
