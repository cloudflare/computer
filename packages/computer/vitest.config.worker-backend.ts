// Workerd-backed runner for the WorkerBackend integration tests.
// The default vitest config aliases ./proxy.js and cloudflare:workers
// to throwing stubs so the node runner doesn't have to resolve them;
// the worker backend's real wiring (Worker Loader binding, the
// bundled ShellWorker, WorkspaceServiceProxy, fs round-trip) only
// works under workerd. Drives that path through SELF.fetch.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.worker-backend.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/worker-backend.test.ts"],
    // SHELL_MODULES splits the bundle so workerd only parses
    // shell.js (~290 KB) on cold start; dynamic chunks load on
    // demand. Boot is still dominated by isolate startup, so a
    // 60s top-level cap gives each case its own per-it timeout
    // headroom without dragging the whole run.
    testTimeout: 60_000,
  },
});
