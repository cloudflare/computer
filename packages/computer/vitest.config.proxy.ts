// Workerd-backed runner for the WorkspaceProxy tests. The default
// vitest config aliases ./proxy.js to a throwing stub so the node
// runner doesn't have to resolve cloudflare:workers; that means
// proxy.ts itself is exercised here and only here.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.proxy.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/proxy.test.ts"],
  },
});
