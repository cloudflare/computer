import { defineConfig } from "vitest/config";

// computerd's test suite spins up real subprocesses (computerd binary boots,
// websocket peers, FUSE shim mount points) so the runner needs
// node — not workerd, and not jsdom. Sequencing is per-file to
// keep concurrent suites from racing on shared port allocators
// and tmp directories.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    // FUSE shim setup + child-process boots are slower than the
    // default 5s. 60s matches what the old node:test harness
    // implicitly allowed.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
