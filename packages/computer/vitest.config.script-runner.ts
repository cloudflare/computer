import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.script-runner.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/script-runner.test.ts"],
    testTimeout: 60_000,
  },
});
