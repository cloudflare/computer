import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Benchmark runner. Reuses the workerd-backed pool (same wrangler
// config as the workers test project) so the harness drives a REAL
// Durable Object SqlStorage — NOT the node SQLiteTestStorage fixture,
// which caches prepared statements and would understate per-statement
// cost. Scoped to the *.bench.ts glob so it never runs during
// `npm test`; invoke explicitly via `npm run bench`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["src/bench/**/*.bench.ts"],
    // The harness builds large trees and loops tens of thousands of
    // synchronous ops; the default 5s timeout is far too tight.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
