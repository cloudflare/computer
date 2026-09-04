import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Durable REPL session tests. Run: npm run test:repl
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.repl.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/repl.test.ts"],
    testTimeout: 60_000,
  },
});
