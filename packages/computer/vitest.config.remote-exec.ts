// The remote-exec suites that run the real binary, with local processes
// standing in for the container (src/remote-exec/testing/local.ts).
// Linux only. Build the binary first with
// `npm run build:dev --workspace @cloudflare/remote-exec`, or point
// REMOTE_EXEC_BIN at a release build. Some cases switch user and only
// run as root. From macOS, run them through
// packages/remote-exec/dev/run.sh.

import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(__dirname, "test-helpers/cloudflare-workers-stub.ts"),
    },
  },
  test: {
    include: ["src/remote-exec/**/*.linux.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // The process tests watch /proc and signal process groups; keep
    // files from interleaving.
    fileParallelism: false,
  },
});
