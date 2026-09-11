// End-to-end restartable sync benchmark.
//
// The dofs harness measures the pieces (planning, pack codec, apply).
// This one measures the thing callers actually experience: driving
// `pullBlocks` to completion against a real peer, in both transport
// modes, and counting what it cost.
//
// Runs under @cloudflare/vitest-pool-workers so both peers are real
// Durable Object SqlStorage instances. Cross-DO I/O isolation means the
// two peers cannot be live in one isolate, so the "remote" is a plain
// in-isolate Database driving createSyncServer while the local side is
// the DO — the transport is a direct stub either way, which is what we
// want: this isolates dofs + engine cost from capnweb and FUSE framing.
//
// The headline numbers are wall time to converge and the worst single
// block, because the worst block is what has to fit inside a Durable
// Object's CPU allowance.
//
// Run with: npm run bench --workspace @cloudflare/computer-rpc

import {
  Database,
  initializeSchema,
  readFetchCursor,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { it } from "vitest";

import { createSyncServer } from "../server.js";
import { pullBlocks } from "../sync-engine.js";

const NOW = (): number => 1000;

function makePeer(): { db: Database; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, NOW);
  return { db, close: () => storage.close() };
}

// Package-shaped source tree: nested directories, many small modules,
// a minority of genuinely shared payloads.
function seedPackageTree(
  db: Database,
  options: { packages: number; filesPerPackage: number; fileBytes: number },
): { files: number; logicalBytes: number } {
  const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
  let files = 0;
  let logicalBytes = 0;
  const body = (p: number, f: number): string => {
    const shared = (p + f) % 8 === 0;
    const seed = shared ? "shared-helper" : `pkg-${p}-lib-${f}`;
    const filler = `${seed} module body with require() calls and comments; `;
    return filler.repeat(Math.ceil(options.fileBytes / filler.length)).slice(0, options.fileBytes);
  };
  for (let p = 0; p < options.packages; p++) {
    const dir = `/node_modules/pkg-${String(p).padStart(4, "0")}`;
    provider.mkdirSync(dir, { recursive: true });
    provider.writeFileSync(`${dir}/package.json`, `{"name":"pkg-${p}","version":"1.0.0"}`);
    files++;
    logicalBytes += 40;
    for (let f = 0; f < options.filesPerPackage; f++) {
      const content = body(p, f);
      provider.writeFileSync(`${dir}/lib-${f}.js`, content);
      files++;
      logicalBytes += content.length;
    }
  }
  return { files, logicalBytes };
}

function table(rows: Record<string, string | number>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const line = (cells: (string | number)[]): string =>
    cells.map((c, i) => String(c).padEnd(width[i])).join("  ");
  console.log(line(keys));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(keys.map((k) => row[k] ?? "")));
}

interface RunResult {
  blocks: number;
  entries: number;
  totalMs: number;
  worstBlockMs: number;
  mode: string;
}

// Drive a pull to completion one block at a time, timing each block.
async function runPull(
  local: Database,
  remoteDb: Database,
  options: { forcePack: boolean; maxEntries: number },
): Promise<RunResult> {
  const rpc = createSyncServer(remoteDb);
  const iterableOptions = {
    profile: { maxEntries: options.maxEntries, maxBytes: 64 * 1024 * 1024 },
    // thresholdEntries of 1 forces pack; a huge one forces entry mode.
    thresholdEntries: options.forcePack ? 1 : Number.MAX_SAFE_INTEGER,
    thresholdBytes: options.forcePack ? 1 : Number.MAX_SAFE_INTEGER,
  };

  let blocks = 0;
  let entries = 0;
  let worstBlockMs = 0;
  let mode = "?";
  const started = performance.now();

  // A fresh iterable per block, which is the eviction-worst-case shape:
  // every block re-reads the durable operation and cursor instead of
  // reusing an in-memory iterator.
  for (let guard = 0; guard < 100_000; guard++) {
    const tBlock = performance.now();
    const iterator = pullBlocks(local, rpc, iterableOptions)[Symbol.asyncIterator]();
    const { value, done } = await iterator.next();
    const blockMs = performance.now() - tBlock;
    if (done) break;
    blocks++;
    entries += value.entries;
    mode = value.mode;
    worstBlockMs = Math.max(worstBlockMs, blockMs);
    if (value.complete) break;
  }

  return {
    blocks,
    entries,
    totalMs: Number((performance.now() - started).toFixed(1)),
    worstBlockMs: Number(worstBlockMs.toFixed(1)),
    mode,
  };
}

it("entry mode versus pack mode, converging a package-shaped tree", async () => {
  const rows: Record<string, string | number>[] = [];
  const json: Record<string, unknown>[] = [];

  const shapes = [
    { label: "small (incremental)", packages: 5, filesPerPackage: 4, fileBytes: 512 },
    { label: "medium", packages: 60, filesPerPackage: 8, fileBytes: 2048 },
    { label: "large (install-shaped)", packages: 200, filesPerPackage: 8, fileBytes: 4096 },
  ];

  for (const shape of shapes) {
    // Seed one source tree and reuse its bytes for both modes so the
    // comparison is apples to apples.
    const source = makePeer();
    const seeded = seedPackageTree(source.db, shape);

    for (const forcePack of [false, true]) {
      const local = makePeer();
      try {
        const result = await runPull(local.db, source.db, { forcePack, maxEntries: 512 });
        const converged = readFetchCursor(local.db).rev > 0;
        const localFiles =
          local.db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_nodes WHERE type = 'file'")
            ?.c ?? 0;
        rows.push({
          shape: shape.label,
          mode: result.mode,
          "source files": seeded.files,
          "logical MB": Number((seeded.logicalBytes / 1024 / 1024).toFixed(2)),
          entries: result.entries,
          blocks: result.blocks,
          "total (ms)": result.totalMs,
          "worst block (ms)": result.worstBlockMs,
          "ms/entry": Number((result.totalMs / Math.max(1, result.entries)).toFixed(3)),
          "files applied": localFiles,
          converged: converged ? "yes" : "no",
        });
        json.push({ shape: shape.label, ...result, sourceFiles: seeded.files });
      } finally {
        local.close();
      }
    }
    source.close();
  }

  console.log("\n=== end-to-end pull: entry vs pack ===");
  table(rows);
  console.log(`BENCH_JSON e2e ${JSON.stringify(json)}`);
});

it("block size sweep: worst block versus round trips", async () => {
  const rows: Record<string, string | number>[] = [];
  const source = makePeer();
  const seeded = seedPackageTree(source.db, {
    packages: 150,
    filesPerPackage: 8,
    fileBytes: 4096,
  });

  for (const maxEntries of [64, 256, 1024]) {
    for (const forcePack of [false, true]) {
      const local = makePeer();
      try {
        const result = await runPull(local.db, source.db, { forcePack, maxEntries });
        rows.push({
          "block max entries": maxEntries,
          mode: result.mode,
          blocks: result.blocks,
          "total (ms)": result.totalMs,
          "worst block (ms)": result.worstBlockMs,
          // How many of the worst-case blocks fit in the default
          // Durable Object CPU allowance. Under 1 would mean a block
          // cannot finish, which is the failure this design exists to
          // avoid.
          "worst blocks per 30s": Math.floor(30_000 / Math.max(1, result.worstBlockMs)),
        });
      } finally {
        local.close();
      }
    }
  }
  source.close();

  console.log(`\n=== block size sweep (${seeded.files} source files) ===`);
  table(rows);
});

// The in-process stub has no wire, so it charges nothing for bytes and
// everything for CPU. That is the worst possible case for a compressed
// transport and it is not the case the pack exists for. Model the wire
// explicitly: measure bytes moved in each mode, then price them at a
// few plausible link speeds.
it("bytes on the wire, priced against link speed", async () => {
  const source = makePeer();
  const seeded = seedPackageTree(source.db, {
    packages: 200,
    filesPerPackage: 8,
    fileBytes: 4096,
  });

  // Count bytes each mode would put on the wire for the same window,
  // plus the CPU each spends locally.
  const measure = async (forcePack: boolean): Promise<{ wireKB: number; cpuMs: number }> => {
    const local = makePeer();
    const rpc = createSyncServer(source.db);
    let wireBytes = 0;

    // Wrap the transport to count bytes actually streamed.
    const counting = new Proxy(rpc as object, {
      get(target, prop, receiver) {
        const real = Reflect.get(target, prop, receiver);
        if (prop === "fetchChangePack") {
          return async (...args: unknown[]) => {
            const res = (await (
              real as (...a: unknown[]) => Promise<{
                stream: ReadableStream<Uint8Array>;
              }>
            ).call(target, ...args)) as {
              stream: ReadableStream<Uint8Array>;
            };
            return {
              ...res,
              stream: res.stream.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    wireBytes += chunk.byteLength;
                    controller.enqueue(chunk);
                  },
                }),
              ),
            };
          };
        }
        if (prop === "fetchObjects") {
          return (...args: unknown[]) => {
            const stream = (
              real as (...a: unknown[]) => ReadableStream<{
                hash: Uint8Array;
                bytes: Uint8Array;
              }>
            ).call(target, ...args);
            return stream.pipeThrough(
              new TransformStream<
                { hash: Uint8Array; bytes: Uint8Array },
                { hash: Uint8Array; bytes: Uint8Array }
              >({
                transform(chunk, controller) {
                  wireBytes += chunk.bytes.byteLength + 32;
                  controller.enqueue(chunk);
                },
              }),
            );
          };
        }
        if (prop === "fetchChanges") {
          return async (...args: unknown[]) => {
            const res = (await (
              real as (...a: unknown[]) => Promise<{
                stream: ReadableStream<unknown>;
              }>
            ).call(target, ...args)) as { stream: ReadableStream<unknown> };
            return {
              ...res,
              stream: res.stream.pipeThrough(
                new TransformStream<unknown, unknown>({
                  transform(chunk, controller) {
                    // Entry records cross the wire as structured
                    // values; JSON length is a fair proxy.
                    wireBytes += JSON.stringify(chunk).length;
                    controller.enqueue(chunk);
                  },
                }),
              ),
            };
          };
        }
        return real;
      },
    }) as typeof rpc;

    const started = performance.now();
    for (let guard = 0; guard < 100_000; guard++) {
      const iterator = pullBlocks(local.db, counting, {
        profile: { maxEntries: 512, maxBytes: 64 * 1024 * 1024 },
        thresholdEntries: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
        thresholdBytes: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
      })[Symbol.asyncIterator]();
      const { value, done } = await iterator.next();
      if (done || value.complete) break;
    }
    const cpuMs = performance.now() - started;
    local.close();
    return { wireKB: Number((wireBytes / 1024).toFixed(1)), cpuMs: Number(cpuMs.toFixed(1)) };
  };

  const entry = await measure(false);
  const pack = await measure(true);
  source.close();

  const rows: Record<string, string | number>[] = [
    { mode: "entries", "wire KB": entry.wireKB, "local CPU (ms)": entry.cpuMs },
    { mode: "pack", "wire KB": pack.wireKB, "local CPU (ms)": pack.cpuMs },
  ];
  console.log(`\n=== bytes on the wire (${seeded.files} files) ===`);
  table(rows);

  // Total time = CPU + bytes/bandwidth. The in-process benchmark above
  // is the bandwidth = infinity column.
  const priced: Record<string, string | number>[] = [];
  for (const mbps of [10, 50, 100, 500, Number.POSITIVE_INFINITY]) {
    const bytesPerMs = (mbps * 1024 * 1024) / 8 / 1000;
    const entryTotal = entry.cpuMs + (entry.wireKB * 1024) / bytesPerMs;
    const packTotal = pack.cpuMs + (pack.wireKB * 1024) / bytesPerMs;
    priced.push({
      "link Mbps": mbps === Number.POSITIVE_INFINITY ? "infinite" : mbps,
      "entries total (ms)": Number(entryTotal.toFixed(0)),
      "pack total (ms)": Number(packTotal.toFixed(0)),
      winner: packTotal < entryTotal ? "pack" : "entries",
      margin: `${Math.abs(((entryTotal - packTotal) / Math.max(1, entryTotal)) * 100).toFixed(0)}%`,
    });
  }
  console.log("\n=== priced against link speed ===");
  table(priced);
  console.log(`BENCH_JSON wire ${JSON.stringify({ entry, pack, files: seeded.files })}`);
});

it("restart overhead: fresh iterable per block versus one iterator", async () => {
  const rows: Record<string, string | number>[] = [];
  const source = makePeer();
  seedPackageTree(source.db, { packages: 120, filesPerPackage: 8, fileBytes: 2048 });

  for (const forcePack of [false, true]) {
    const options = {
      profile: { maxEntries: 128, maxBytes: 64 * 1024 * 1024 },
      thresholdEntries: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
      thresholdBytes: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
    };

    // (a) One long-lived iterator: the happy path, no eviction.
    const reused = makePeer();
    const rpcA = createSyncServer(source.db);
    const tReused = performance.now();
    let reusedBlocks = 0;
    for await (const progress of pullBlocks(reused.db, rpcA, options)) {
      reusedBlocks++;
      if (progress.complete) break;
    }
    const reusedMs = Number((performance.now() - tReused).toFixed(1));
    const mode = reusedBlocks > 0 ? (forcePack ? "pack" : "entries") : "?";
    reused.close();

    // (b) A fresh iterable for every block: what an evicted Durable
    // Object costs, since each block re-reads the operation row and
    // cursor from SQLite.
    const restarted = makePeer();
    const result = await runPull(restarted.db, source.db, {
      forcePack,
      maxEntries: 128,
    });
    restarted.close();

    rows.push({
      mode,
      "reused iterator (ms)": reusedMs,
      "reused blocks": reusedBlocks,
      "fresh per block (ms)": result.totalMs,
      "fresh blocks": result.blocks,
      "restart overhead": `${(((result.totalMs - reusedMs) / Math.max(1, reusedMs)) * 100).toFixed(0)}%`,
    });
  }
  source.close();

  console.log("\n=== restart overhead ===");
  table(rows);
});
