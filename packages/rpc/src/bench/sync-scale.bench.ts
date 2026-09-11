// Install-scale sync benchmark.
//
// The engine benchmark next door uses small trees so it can sweep many
// shapes quickly. This one targets the size the plan actually cites as
// its motivating case: a package-install tree of roughly 40,000 entries.
// The plan's reference run was 44,264 entries over an estimated
// 915 MB cursor window, sending 33,683 unique objects in a 257 MB gzip
// stream, and it wants that to stay materially faster than an unbounded
// entry pull.
//
// Seeding this tree costs real time (about 0.4 ms per file, so ~20 s at
// 45,000 files) and the sync itself is measured in seconds, so the
// scenarios here are deliberately few and the whole file is gated behind
// an env var:
//
//   SYNC_SCALE=1 npm run bench --workspace @cloudflare/computer-rpc
//
// Without the flag the suite reports skipped, so the default bench run
// stays fast.
//
// Byte totals are scaled down from the plan's 915 MB by default because
// a 1 GB tree in one Durable Object SQLite database is a separate
// question from block sequencing; SYNC_SCALE_BYTES raises the per-file
// payload when that is the thing under test.

import {
  Database,
  initializeSchema,
  readFetchCursor,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, it } from "vitest";

import { createSyncServer } from "../server.js";
import { pullBlocks } from "../sync-engine.js";

const NOW = (): number => 1000;
const ENABLED = process.env.SYNC_SCALE === "1";
// Files per package is 9 (one manifest plus eight modules), so 4900
// packages lands near the plan's 44,264 entries.
const PACKAGES = Number(process.env.SYNC_SCALE_PACKAGES ?? 4900);
const FILE_BYTES = Number(process.env.SYNC_SCALE_BYTES ?? 1024);

function makePeer(): { db: Database; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, NOW);
  return { db, close: () => storage.close() };
}

function seedInstallTree(db: Database): { files: number; logicalBytes: number; seedMs: number } {
  const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
  const started = performance.now();
  let files = 0;
  let logicalBytes = 0;
  // A real install has a long tail of unique modules over a base of
  // widely vendored helpers. One in eight files is a shared payload so
  // the content-addressed store has genuine duplicates to collapse,
  // matching the plan's 44,264 entries against 33,683 unique objects
  // (roughly a quarter deduplicated).
  const body = (p: number, f: number): string => {
    const shared = (p + f) % 4 === 0;
    const seed = shared ? `shared-helper-${(p + f) % 64}` : `pkg-${p}-lib-${f}`;
    const filler = `${seed} module body with require() calls and comments; `;
    return filler.repeat(Math.ceil(FILE_BYTES / filler.length)).slice(0, FILE_BYTES);
  };
  for (let p = 0; p < PACKAGES; p++) {
    const dir = `/node_modules/pkg-${String(p).padStart(5, "0")}`;
    provider.mkdirSync(dir, { recursive: true });
    provider.writeFileSync(`${dir}/package.json`, `{"name":"pkg-${p}","version":"1.0.0"}`);
    files++;
    logicalBytes += 40;
    for (let f = 0; f < 8; f++) {
      const content = body(p, f);
      provider.writeFileSync(`${dir}/lib-${f}.js`, content);
      files++;
      logicalBytes += content.length;
    }
  }
  return { files, logicalBytes, seedMs: performance.now() - started };
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

// Count bytes crossing the transport so the comparison is not decided
// by an in-process stub that charges nothing for them.
function countingTransport(rpc: ReturnType<typeof createSyncServer>): {
  rpc: ReturnType<typeof createSyncServer>;
  wireBytes: () => number;
} {
  let bytes = 0;
  const wrapped = new Proxy(rpc as object, {
    get(target, prop, receiver) {
      const real = Reflect.get(target, prop, receiver);
      if (prop === "fetchChangePack") {
        return async (...args: unknown[]) => {
          const res = (await (
            real as (...a: unknown[]) => Promise<{ stream: ReadableStream<Uint8Array> }>
          ).call(target, ...args)) as { stream: ReadableStream<Uint8Array> };
          return {
            ...res,
            stream: res.stream.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
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
            real as (...a: unknown[]) => ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>
          ).call(target, ...args);
          return stream.pipeThrough(
            new TransformStream<
              { hash: Uint8Array; bytes: Uint8Array },
              { hash: Uint8Array; bytes: Uint8Array }
            >({
              transform(chunk, controller) {
                bytes += chunk.bytes.byteLength + 32;
                controller.enqueue(chunk);
              },
            }),
          );
        };
      }
      if (prop === "fetchChanges") {
        return async (...args: unknown[]) => {
          const res = (await (
            real as (...a: unknown[]) => Promise<{ stream: ReadableStream<unknown> }>
          ).call(target, ...args)) as { stream: ReadableStream<unknown> };
          return {
            ...res,
            stream: res.stream.pipeThrough(
              new TransformStream<unknown, unknown>({
                transform(chunk, controller) {
                  bytes += JSON.stringify(chunk).length;
                  controller.enqueue(chunk);
                },
              }),
            ),
          };
        };
      }
      return real;
    },
  }) as ReturnType<typeof createSyncServer>;
  return { rpc: wrapped, wireBytes: () => bytes };
}

describe.skipIf(!ENABLED)("install-scale sync", () => {
  it("converges a package-install tree in bounded blocks", async () => {
    const source = makePeer();
    const seeded = seedInstallTree(source.db);
    console.log(
      `\nseeded ${seeded.files} files, ` +
        `${(seeded.logicalBytes / 1024 / 1024).toFixed(1)} MB logical, ` +
        `in ${(seeded.seedMs / 1000).toFixed(1)}s`,
    );

    const rows: Record<string, string | number>[] = [];
    const json: Record<string, unknown>[] = [];

    for (const forcePack of [false, true]) {
      const local = makePeer();
      const counted = countingTransport(createSyncServer(source.db));
      const options = {
        // The shipped default profile, so this measures what production
        // would actually do rather than a tuned-for-benchmark size.
        profile: { maxEntries: 4000, maxBytes: 64 * 1024 * 1024 },
        thresholdEntries: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
        thresholdBytes: forcePack ? 1 : Number.MAX_SAFE_INTEGER,
      };

      let blocks = 0;
      let entries = 0;
      let worstBlockMs = 0;
      let mode = "?";
      const started = performance.now();
      // Fresh iterable per block: the eviction worst case, where every
      // block re-reads the operation row and cursor from SQLite.
      for (let guard = 0; guard < 100_000; guard++) {
        const tBlock = performance.now();
        const iterator = pullBlocks(local.db, counted.rpc, options)[Symbol.asyncIterator]();
        const { value, done } = await iterator.next();
        const blockMs = performance.now() - tBlock;
        if (done) break;
        blocks++;
        entries += value.entries;
        mode = value.mode;
        worstBlockMs = Math.max(worstBlockMs, blockMs);
        if (value.complete) break;
      }
      const totalMs = performance.now() - started;
      const appliedFiles =
        local.db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_nodes WHERE type = 'file'")?.c ??
        0;
      const uniqueObjects =
        local.db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_blobs")?.c ?? 0;
      const wireKB = counted.wireBytes() / 1024;

      rows.push({
        mode,
        entries,
        blocks,
        "unique objects": uniqueObjects,
        "wire MB": Number((wireKB / 1024).toFixed(1)),
        "total (s)": Number((totalMs / 1000).toFixed(1)),
        "worst block (ms)": Number(worstBlockMs.toFixed(0)),
        "ms/entry": Number((totalMs / Math.max(1, entries)).toFixed(3)),
        "files applied": appliedFiles,
        converged:
          readFetchCursor(local.db).rev > 0 && appliedFiles === seeded.files ? "yes" : "no",
      });
      json.push({
        mode,
        entries,
        blocks,
        wireKB: Number(wireKB.toFixed(1)),
        totalMs: Number(totalMs.toFixed(0)),
        worstBlockMs: Number(worstBlockMs.toFixed(0)),
        appliedFiles,
        sourceFiles: seeded.files,
      });
      local.close();
    }

    console.log("\n=== install-scale pull ===");
    table(rows);

    // Price the byte difference against a link, since an in-process
    // peer charges nothing for bytes and that is the one input the
    // entries-versus-pack question turns on.
    const entryRun = json[0] as { totalMs: number; wireKB: number };
    const packRun = json[1] as { totalMs: number; wireKB: number };
    const priced: Record<string, string | number>[] = [];
    for (const mbps of [10, 50, 100, 500, Number.POSITIVE_INFINITY]) {
      const bytesPerMs = (mbps * 1024 * 1024) / 8 / 1000;
      const e = entryRun.totalMs + (entryRun.wireKB * 1024) / bytesPerMs;
      const p = packRun.totalMs + (packRun.wireKB * 1024) / bytesPerMs;
      priced.push({
        "link Mbps": mbps === Number.POSITIVE_INFINITY ? "infinite" : mbps,
        "entries total (s)": Number((e / 1000).toFixed(1)),
        "pack total (s)": Number((p / 1000).toFixed(1)),
        winner: p < e ? "pack" : "entries",
        margin: `${Math.abs(((e - p) / Math.max(1, e)) * 100).toFixed(0)}%`,
      });
    }
    console.log("\n=== install-scale, priced against link speed ===");
    table(priced);
    console.log(`BENCH_JSON scale ${JSON.stringify(json)}`);

    source.close();
  });
});
