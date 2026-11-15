// Workerd-backed runner for the KitebuildBackend integration tests. A
// Kitebuild machine imports cloudflare:sockets and precompiled wasm,
// so it only runs under workerd.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.kitebuild-backend.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/kitebuild-backend.test.ts"],
    testTimeout: 60_000,
  },
});
