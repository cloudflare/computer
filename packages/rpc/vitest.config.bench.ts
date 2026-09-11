import { defineConfig } from "vitest/config";

// Benchmark runner for the sync engine.
//
// Uses the plain node pool, not vitest-pool-workers: these scenarios
// need two peers live in one process, and workerd hard-isolates I/O
// objects between Durable Objects so a two-peer sync cannot run inside
// a single DO context. The dofs bench covers the real-SqlStorage
// per-statement cost; this one isolates the engine's own overhead —
// block sequencing, pack framing, and restart cost — from the storage
// backend underneath it.
//
// Scoped to src/bench/**.bench.ts so it never runs during `npm test`.
export default defineConfig({
  test: {
    globals: true,
    include: ["src/bench/**/*.bench.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
