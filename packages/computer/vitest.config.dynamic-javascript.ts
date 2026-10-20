import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.dynamic-javascript.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/dynamic-javascript.test.ts"],
    testTimeout: 60_000,
  },
});
