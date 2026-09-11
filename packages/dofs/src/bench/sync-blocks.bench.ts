// Restartable sync benchmark.
//
// Runs under @cloudflare/vitest-pool-workers so every statement drives a
// REAL Durable Object SqlStorage. That matters more here than in most
// harnesses: the whole point of block-at-a-time sync is to stay inside a
// Durable Object's CPU allowance, and the node SQLiteTestStorage fixture
// caches prepared statements and would understate per-statement cost.
//
// What this measures:
//
//   * Block planning cost as a cursor window grows. planBlock is on the
//     hot path for both directions and is the step that has to stay
//     sublinear-ish in the window it is *not* selecting.
//   * Pack encode and decode throughput, plus the compression ratio the
//     transport actually achieves on package-shaped trees.
//   * Mode selection cost, which runs once per operation and must not
//     scan a window it is only sizing.
//   * Per-block apply cost at several block sizes, which is the number
//     that decides whether a block fits in the 30-second CPU limit.
//
// Output is a set of tables plus one JSON line per group so before and
// after runs are easy to diff. Run with:
//   npm run bench --workspace @cloudflare/dofs

import { env, runInDurableObject } from "cloudflare:test";
import { it } from "vitest";
import type { TestBindings } from "../../tests/worker.js";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { applyChanges } from "../sync/apply.js";
import { planBlock, selectMode } from "../sync/blocks.js";
import { decodeChangePack, encodeChangePack } from "../sync/change-pack.js";
import { MIN_BLOCK_PROFILE } from "../sync/operations.js";
import { currentRev } from "../sync/watermarks.js";
import type { DurableObjectStorageLike } from "../types.js";

const NOW = (): number => 1000;
const BIG_PROFILE = { maxEntries: 1_000_000, maxBytes: Number.MAX_SAFE_INTEGER };

function freshStub(): DurableObjectStub {
  const ns = (env as unknown as TestBindings).TestStorage;
  return ns.get(ns.newUniqueId());
}

async function withRealDB<T>(fn: (db: Database) => Promise<T> | T): Promise<T> {
  return runInDurableObject(freshStub(), async (_i: unknown, state: DurableObjectState) => {
    const db = new Database(state.storage as unknown as DurableObjectStorageLike);
    initializeSchema(db, NOW);
    return await fn(db);
  });
}

// A package-shaped tree: many small files spread across nested
// directories, with the duplication a real node_modules exhibits (the
// same helper vendored under several packages). Shape matters — the
// planner's cost is driven by directory fan-out and the pack's ratio by
// how compressible and how duplicated the payloads are.
function seedPackageTree(
  db: Database,
  options: { packages: number; filesPerPackage: number; fileBytes: number },
): { files: number; logicalBytes: number } {
  const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
  let files = 0;
  let logicalBytes = 0;
  // Payloads are mostly distinct, with a minority genuinely shared, so
  // the content-addressed store has real duplicates to collapse without
  // the whole tree collapsing to one object. Seeding every file with
  // identical bytes would make dedup do all the work and leave the pack
  // measuring nothing.
  const body = (p: number, f: number): string => {
    // Every 8th file is a vendored copy of a shared helper.
    const shared = (p + f) % 8 === 0;
    const seed = shared ? "shared-helper" : `pkg-${p}-lib-${f}`;
    const filler = `${seed} module body with require() calls and comments; `;
    return filler.repeat(Math.ceil(options.fileBytes / filler.length)).slice(0, options.fileBytes);
  };
  for (let p = 0; p < options.packages; p++) {
    const dir = `/node_modules/pkg-${String(p).padStart(4, "0")}`;
    provider.mkdirSync(dir, { recursive: true });
    provider.writeFileSync(
      `${dir}/package.json`,
      `{"name":"pkg-${p}","version":"1.0.0","main":"index.js"}`,
    );
    files++;
    logicalBytes += 48;
    for (let f = 0; f < options.filesPerPackage; f++) {
      const content = body(p, f);
      provider.writeFileSync(`${dir}/lib-${f}.js`, content);
      files++;
      logicalBytes += content.length;
    }
  }
  return { files, logicalBytes };
}

function ms(start: number): number {
  return Number((performance.now() - start).toFixed(1));
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

// ---------------------------------------------------------------------
// Block planning as the window grows.
// ---------------------------------------------------------------------

it("block planning scales with the block, not the window", async () => {
  const rows: Record<string, string | number>[] = [];
  const json: Record<string, unknown>[] = [];

  for (const packages of [10, 40, 160]) {
    await withRealDB(async (db) => {
      const seeded = seedPackageTree(db, { packages, filesPerPackage: 6, fileBytes: 512 });
      const target = { rev: currentRev(db), path: null };

      // Whole window in one block: the cost floor for "ship everything".
      const tFull = performance.now();
      const full = await planBlock(db, {
        after: { rev: 0, path: null },
        through: target,
        profile: BIG_PROFILE,
      });
      const fullMs = ms(tFull);

      // One bounded block out of the same window. This is the number
      // that has to stay flat as the window grows, or a big sync pays
      // for the whole window on every block.
      const tBlock = performance.now();
      const block = await planBlock(db, {
        after: { rev: 0, path: null },
        through: target,
        profile: { maxEntries: 256, maxBytes: 8 * 1024 * 1024 },
      });
      const blockMs = ms(tBlock);

      rows.push({
        packages,
        "window entries": full.entries.length,
        "seeded files": seeded.files,
        "plan window (ms)": fullMs,
        "plan 256-entry block (ms)": blockMs,
        "block entries": block.entries.length,
        "us/entry (window)": Number(((fullMs * 1000) / full.entries.length).toFixed(1)),
      });
      json.push({
        packages,
        windowEntries: full.entries.length,
        fullMs,
        blockMs,
        blockEntries: block.entries.length,
      });
    });
  }

  console.log("\n=== block planning ===");
  table(rows);
  console.log(`BENCH_JSON plan ${JSON.stringify(json)}`);
});

// ---------------------------------------------------------------------
// Pack encode / decode throughput and compression ratio.
// ---------------------------------------------------------------------

it("pack encode and decode throughput", async () => {
  const rows: Record<string, string | number>[] = [];
  const json: Record<string, unknown>[] = [];

  for (const shape of [
    { label: "metadata-heavy", packages: 250, filesPerPackage: 8, fileBytes: 512 },
    { label: "byte-heavy", packages: 60, filesPerPackage: 8, fileBytes: 64 * 1024 },
  ]) {
    await withRealDB(async (db) => {
      const seeded = seedPackageTree(db, shape);
      const target = { rev: currentRev(db), path: null };
      const block = await planBlock(db, {
        after: { rev: 0, path: null },
        through: target,
        profile: BIG_PROFILE,
      });

      const tEncode = performance.now();
      const stream = encodeChangePack(db, {
        block,
        after: { rev: 0, path: null },
        target,
        generation: "bench",
      });
      // Drain to bytes so encode time includes gzip, not just planning.
      const chunks: Uint8Array[] = [];
      let packBytes = 0;
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        packBytes += value.byteLength;
      }
      reader.releaseLock();
      const encodeMs = ms(tEncode);

      const joined = new Uint8Array(packBytes);
      let offset = 0;
      for (const c of chunks) {
        joined.set(c, offset);
        offset += c.byteLength;
      }

      const tDecode = performance.now();
      const decoded = await decodeChangePack(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(joined);
            controller.close();
          },
        }),
      );
      const decodeMs = ms(tDecode);

      // The pack replaces both the entry stream and the object bytes,
      // so the ratio has to count both. Comparing against object bytes
      // alone reads as inflation on a metadata-heavy tree, where entry
      // records dominate the payload.
      const entryBytes = block.entries.reduce((total, e) => total + JSON.stringify(e).length, 0);
      const wireBytes = entryBytes + block.objectBytes;
      const ratio = Number((wireBytes / Math.max(1, packBytes)).toFixed(2));
      rows.push({
        shape: shape.label,
        entries: block.entries.length,
        objects: block.objects.length,
        "logical MB": Number((seeded.logicalBytes / 1024 / 1024).toFixed(2)),
        "entry KB": Number((entryBytes / 1024).toFixed(1)),
        "object KB": Number((block.objectBytes / 1024).toFixed(1)),
        "uncompressed KB": Number((wireBytes / 1024).toFixed(1)),
        "pack KB": Number((packBytes / 1024).toFixed(1)),
        "gzip ratio": `${ratio}x`,
        "encode (ms)": encodeMs,
        "decode (ms)": decodeMs,
        "encode MB/s": Number((wireBytes / 1024 / 1024 / (encodeMs / 1000)).toFixed(1)),
      });
      json.push({
        shape: shape.label,
        entries: block.entries.length,
        objectBytes: block.objectBytes,
        entryBytes,
        wireBytes,
        packBytes,
        ratio,
        encodeMs,
        decodeMs,
        decodedEntries: decoded.entries.length,
      });
    });
  }

  console.log("\n=== pack codec ===");
  table(rows);
  console.log(`BENCH_JSON pack ${JSON.stringify(json)}`);
});

// ---------------------------------------------------------------------
// Mode selection: runs once per operation, must not scan the window.
// ---------------------------------------------------------------------

it("mode selection cost", async () => {
  const rows: Record<string, string | number>[] = [];
  await withRealDB(async (db) => {
    seedPackageTree(db, { packages: 120, filesPerPackage: 6, fileBytes: 512 });
    const target = { rev: currentRev(db), path: null };

    // Low threshold: the probe fills almost immediately and the
    // decision is made without draining the window.
    const tLow = performance.now();
    const low = await selectMode(db, {
      after: { rev: 0, path: null },
      through: target,
      profile: MIN_BLOCK_PROFILE,
      thresholdEntries: 64,
    });
    const lowMs = ms(tLow);

    // Production threshold: the window is far below 20k, so the probe
    // drains it and reports entry mode.
    const tHigh = performance.now();
    const high = await selectMode(db, {
      after: { rev: 0, path: null },
      through: target,
      profile: MIN_BLOCK_PROFILE,
    });
    const highMs = ms(tHigh);

    rows.push(
      {
        case: "threshold crossed early (64)",
        mode: low.mode,
        "first block entries": low.firstBlock.entries.length,
        "select (ms)": lowMs,
      },
      {
        case: "production threshold (20000)",
        mode: high.mode,
        "first block entries": high.firstBlock.entries.length,
        "select (ms)": highMs,
      },
    );
  });

  console.log("\n=== mode selection ===");
  table(rows);
});

// ---------------------------------------------------------------------
// Per-block apply cost at several block sizes.
// ---------------------------------------------------------------------

it("per-block apply cost by block size", async () => {
  const rows: Record<string, string | number>[] = [];
  const json: Record<string, unknown>[] = [];

  // Capture one window's entries and object bytes from a source DO,
  // then apply them into a fresh DO in bounded blocks. Cross-DO I/O
  // isolation means the snapshot has to be plain values.
  const snapshot = await withRealDB(async (db) => {
    seedPackageTree(db, { packages: 60, filesPerPackage: 6, fileBytes: 1024 });
    const block = await planBlock(db, {
      after: { rev: 0, path: null },
      through: { rev: currentRev(db), path: null },
      profile: BIG_PROFILE,
    });
    const objects: [string, Uint8Array][] = [];
    for (const object of block.objects) {
      const row = db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        object.hash,
      );
      if (row !== undefined) {
        let key = "";
        for (const b of object.hash) key += b.toString(16).padStart(2, "0");
        objects.push([key, row.bytes]);
      }
    }
    return { entries: block.entries, objects, objectBytes: block.objectBytes };
  });

  for (const blockSize of [64, 256, 1024]) {
    await withRealDB(async (db) => {
      const objectMap = new Map(snapshot.objects);
      const started = performance.now();
      let blocks = 0;
      let applied = 0;
      let worstBlockMs = 0;
      for (let i = 0; i < snapshot.entries.length; i += blockSize) {
        const slice = snapshot.entries.slice(i, i + blockSize);
        const tBlock = performance.now();
        const result = await applyChanges(db, slice, objectMap, { source: "upstream" });
        const blockMs = performance.now() - tBlock;
        worstBlockMs = Math.max(worstBlockMs, blockMs);
        applied += result.applied;
        blocks++;
      }
      const totalMs = ms(started);
      rows.push({
        "block size": blockSize,
        blocks,
        "entries applied": applied,
        "total (ms)": totalMs,
        "worst block (ms)": Number(worstBlockMs.toFixed(1)),
        "ms/entry": Number((totalMs / Math.max(1, applied)).toFixed(3)),
        "blocks per 30s CPU": Math.floor(30_000 / Math.max(1, worstBlockMs)),
      });
      json.push({
        blockSize,
        blocks,
        applied,
        totalMs,
        worstBlockMs: Number(worstBlockMs.toFixed(1)),
      });
    });
  }

  console.log("\n=== per-block apply ===");
  console.log(
    `source window: ${snapshot.entries.length} entries, ` +
      `${(snapshot.objectBytes / 1024 / 1024).toFixed(2)} MB objects, ` +
      `${snapshot.objects.length} unique`,
  );
  table(rows);
  console.log(`BENCH_JSON apply ${JSON.stringify(json)}`);
});
