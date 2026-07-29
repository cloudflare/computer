// Workerd-backed runner for the WorkspaceStub disposal soak.
//
// Mirrors vitest.config.proxy.ts but points at the stub-soak
// wrangler + test files. Runs separately from the default node
// vitest project (which can't construct WorkerEntrypoints).

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.stub-soak.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/stub-soak.test.ts"],
  },
});
