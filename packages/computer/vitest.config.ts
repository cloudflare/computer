import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // proxy.ts imports cloudflare:workers (WorkerEntrypoint),
      // which doesn't resolve under the node runner. Tests don't
      // need the real class — the package is workerd-only at
      // runtime — so alias to a throwing stub for any test that
      // incidentally pulls it through the import graph.
      {
        find: "./proxy.js",
        replacement: resolve(__dirname, "src/proxy-stub.ts"),
      },
      // The worker backend's entrypoint extends WorkerEntrypoint
      // from cloudflare:workers. Same shape: alias to a stub for
      // the node runner.
      {
        find: "cloudflare:workers",
        replacement: resolve(__dirname, "test-helpers/cloudflare-workers-stub.ts"),
      },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // The docker harness has its own config and globalSetup;
    // it runs via `npm run test:harness`. Excluded here so the
    // unit-test command doesn't try to boot a container.
    exclude: ["src/test-harness/**"],
  },
});
