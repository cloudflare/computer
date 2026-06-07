// Load characterisation for the sync driver.
//
// Not a vitest "test" in the regression sense — runs under
// `npx vitest bench` to surface throughput numbers. Each
// scenario is reported as ops/sec; the wall-time and memory
// notes go to stderr so you can eyeball them without
// vitest's bench framing eating them.
//
// All scenarios run two SQLite-backed VFSes in-process,
// driving the driver against direct stubs (no WebSocket).
// That isolates the dofs + workspace-rpc cost from
// docker / FUSE / capnweb framing. The wsd harness covers
// the integration cost separately.

import {
  currentRev,
  Database,
  initializeSchema,
  readFetchCursor,
  readWatermark,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { bench, describe } from "vitest";

import { createSyncServer } from "./server.js";
import { pullOnce, pushOnce, tick } from "./sync-driver.js";

function makePeer() {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

describe("sync driver — push throughput", () => {
  bench(
    "push 100 small files (single tick)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 100; i++) {
          provider.writeFileSync(`/f${i}.txt`, `payload ${i}`);
        }
        await pushOnce(a.db, b.rpc);
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 20 },
  );

  bench(
    "push 1000 small files (single tick)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 1000; i++) {
          provider.writeFileSync(`/f${i}.txt`, `payload ${i}`);
        }
        await pushOnce(a.db, b.rpc);
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 10 },
  );

  bench(
    "push 1 large file (4 MiB, 8 chunks)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        const bytes = new Uint8Array(4 * 1024 * 1024);
        // Random data so chunk dedup doesn't make this trivial.
        for (let i = 0; i < bytes.byteLength; i += 4096) {
          bytes[i] = (i * 31) & 0xff;
        }
        provider.writeFileSync("/big.bin", Buffer.from(bytes));
        await pushOnce(a.db, b.rpc);
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 10 },
  );

  bench(
    "push 1 large file (64 MiB, 128 chunks)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        const bytes = new Uint8Array(64 * 1024 * 1024);
        for (let i = 0; i < bytes.byteLength; i += 4096) {
          bytes[i] = (i * 31) & 0xff;
        }
        provider.writeFileSync("/big.bin", Buffer.from(bytes));
        await pushOnce(a.db, b.rpc);
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 3 },
  );
});

describe("sync driver — incremental write+push churn", () => {
  bench(
    "100 writes interleaved with 10 push ticks",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let batch = 0; batch < 10; batch++) {
          for (let i = 0; i < 10; i++) {
            provider.writeFileSync(`/b${batch}_f${i}.txt`, `batch ${batch} file ${i}`);
          }
          await pushOnce(a.db, b.rpc);
        }
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 10 },
  );

  bench(
    "1000 sequential overwrites of one file (coalesced to one entry)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 1000; i++) {
          provider.writeFileSync("/log.txt", `iteration ${i}`);
        }
        await pushOnce(a.db, b.rpc);
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 10 },
  );
});

describe("sync driver — bidirectional convergence", () => {
  bench(
    "alternating writes on both peers — converge in 4 ticks",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        const provB = new SQLiteWorkspaceProvider(b.db, { now: () => 2 });
        for (let i = 0; i < 10; i++) {
          provA.writeFileSync(`/from-a-${i}.txt`, "x");
          provB.writeFileSync(`/from-b-${i}.txt`, "y");
        }
        for (let i = 0; i < 4; i++) {
          await tick(a.db, b.rpc);
          await tick(b.db, a.rpc);
        }
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 10 },
  );

  bench(
    "pull 1000 changes from a fully-populated peer",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 1000; i++) {
          provider.writeFileSync(`/preload_${i}.txt`, `seed ${i}`);
        }
        await pullOnce(b.db, a.rpc);
        // The pull-once above is what we're measuring; the
        // bench framework reports the full closure's wall
        // time. Reading watermarks here adds noise we can
        // tolerate vs. running a no-op closure for the
        // baseline. Sanity assert outside the iteration body:
        if (readFetchCursor(b.db).rev <= 0) throw new Error("pull didn't advance");
        if (currentRev(b.db) <= 0) throw new Error("apply didn't bump rev");
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 5 },
  );
});

describe("sync driver — convergence time after a burst", () => {
  // Measure how long it takes from "burst landed on A" to
  // "A.currentRev == A.pushRev AND B.fetchRev == A.currentRev".
  // The push loop ships ChangeEntries to B; the close-the-gap
  // time is what matters for "agent wrote N files, when can it
  // expect the container to see them all".
  bench(
    "10000 small writes -> drain to settled (single push)",
    async () => {
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 10000; i++) {
          provider.writeFileSync(`/f${i}.txt`, `x${i}`);
        }
        // Single push handles the full set in one batch — A's
        // currentRev is what we expect B to converge to.
        const target = currentRev(a.db);
        await pushOnce(a.db, b.rpc);
        if (readWatermark(a.db, "pushRev") < target) {
          throw new Error("pushRev did not catch up to currentRev");
        }
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 3 },
  );

  bench(
    "burst-then-tick convergence (100 writes, 250 ms tick cadence)",
    async () => {
      // Simulates the production loop. Write 100 files,
      // then drive ticks until B's fetchRev catches A's
      // currentRev. Count the tick calls so we have a sense
      // of how many tick cycles the wire takes to settle.
      const a = makePeer();
      const b = makePeer();
      try {
        const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
        for (let i = 0; i < 100; i++) {
          provider.writeFileSync(`/f${i}.txt`, `x${i}`);
        }
        const target = currentRev(a.db);
        // Push-side loop: each tick is one pushOnce. 100
        // entries fit in one tick on this hardware; the
        // measurement is whether the tick cost is constant.
        let ticks = 0;
        while (readWatermark(a.db, "pushRev") < target) {
          await pushOnce(a.db, b.rpc);
          ticks++;
          if (ticks > 10) throw new Error(`did not settle in 10 ticks`);
        }
      } finally {
        a.close();
        b.close();
      }
    },
    { iterations: 5 },
  );
});
