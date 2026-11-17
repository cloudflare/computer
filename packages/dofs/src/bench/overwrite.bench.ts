// Overwrite and read latency benchmark.
//
// Runs under @cloudflare/vitest-pool-workers so every statement drives
// a REAL Durable Object SqlStorage, like the other harnesses here.
//
// What this measures:
//
//   * Overwrite latency (p50 and p99) for 1 KiB, 100 KiB and 5 MiB
//     files, saved over and over the way an editor saves. Every save
//     changes one byte in each chunk, so every chunk gets a new hash and
//     the previous version becomes garbage in full.
//   * What that leaves behind: the number of blob rows and the database
//     size after the run. A store that reclaims dropped chunks stays at
//     one version's worth; one that doesn't grows with every save.
//   * Read latency (p50 and p99) for a lazy binary readFile stream
//     drained to the end, a string readFile, and a positional
//     readRangeSync, so a change to the write path can show it left
//     reads alone.
//
// The clock inside workerd ticks in whole milliseconds, which is
// coarser than one small save. Each sample is therefore the mean of a
// batch of operations sized to take a few milliseconds, and p50 and
// p99 are taken over the batches. A single slow operation inside a
// batch shows up diluted by the batch size.
//
// Output is a table plus a single-line JSON blob so before and after
// runs are easy to diff. Run with:
//   npm run bench --workspace @cloudflare/dofs

import { env, runInDurableObject } from "cloudflare:test";
import { it } from "vitest";
import type { TestBindings } from "../../tests/worker";
import { readFile, readRangeSync } from "../fs/readFile";
import { CHUNK_SIZE, writeFileSync } from "../fs/writeFile";
import { initializeSchema } from "../schema/index";
import { Database } from "../storage";

const NOW = (): number => 1000;

interface RealStorage {
  readonly databaseSize?: number;
}

function freshStub(): DurableObjectStub {
  const ns = (env as unknown as TestBindings).TestStorage;
  return ns.get(ns.newUniqueId());
}

async function withRealDb<T>(
  fn: (db: Database, storage: RealStorage) => Promise<T> | T,
): Promise<T> {
  return runInDurableObject(freshStub(), async (_i: unknown, state: DurableObjectState) => {
    const db = new Database(state.storage);
    initializeSchema(db, NOW);
    return await fn(db, state.storage.sql as unknown as RealStorage);
  });
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function content(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

// Stamp the save number and the chunk index at the start of every
// chunk, so each save produces all-new hashes and no two chunks of one
// file dedupe into a single blob.
function touchEveryChunk(bytes: Uint8Array, save: number): void {
  for (let offset = 0, idx = 0; offset < bytes.byteLength; offset += CHUNK_SIZE, idx++) {
    const stamp = [save & 0xff, (save >> 8) & 0xff, idx & 0xff];
    for (let i = 0; i < stamp.length && offset + i < bytes.byteLength; i++) {
      bytes[offset + i] = stamp[i];
    }
  }
}

interface OverwriteResult {
  name: string;
  saves: number;
  batch: number;
  p50Ms: number;
  p99Ms: number;
  blobs: number;
  manifests: number;
  databaseMiB: number;
}

interface ReadResult {
  name: string;
  iters: number;
  batch: number;
  p50Ms: number;
  p99Ms: number;
}

async function benchOverwrite(
  label: string,
  size: number,
  batches: number,
  batch: number,
): Promise<OverwriteResult> {
  return withRealDb((db, storage) => {
    const bytes = content(size);
    touchEveryChunk(bytes, 0);
    writeFileSync(db, "/edited.bin", bytes, {}, NOW);
    const samples: number[] = [];
    let save = 0;
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let i = 0; i < batch; i++) {
        touchEveryChunk(bytes, ++save);
        writeFileSync(db, "/edited.bin", bytes, {}, NOW);
      }
      samples.push((performance.now() - t0) / batch);
    }
    return {
      name: `overwrite(${label})`,
      saves: save,
      batch,
      p50Ms: percentile(samples, 50),
      p99Ms: percentile(samples, 99),
      blobs: db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0,
      manifests: db.scalar<number>("SELECT COUNT(*) FROM vfs_manifests") ?? 0,
      databaseMiB: (storage.databaseSize ?? 0) / (1024 * 1024),
    };
  });
}

async function benchRead(
  name: string,
  size: number,
  batches: number,
  batch: number,
  op: (db: Database) => Promise<void> | void,
): Promise<ReadResult> {
  return withRealDb(async (db) => {
    const bytes = content(size);
    touchEveryChunk(bytes, 0);
    writeFileSync(db, "/read.bin", bytes, {}, NOW);
    for (let i = 0; i < batch; i++) await op(db);
    const samples: number[] = [];
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let i = 0; i < batch; i++) await op(db);
      samples.push((performance.now() - t0) / batch);
    }
    return {
      name,
      iters: batches * batch,
      batch,
      p50Ms: percentile(samples, 50),
      p99Ms: percentile(samples, 99),
    };
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // Pull every chunk so the lazy stream reads all of its bytes.
  }
}

function ms(value: number): string {
  return `${value.toFixed(3)}ms`;
}

it("dofs overwrite and read latency (real DO SqlStorage)", async () => {
  const overwrites = [
    await benchOverwrite("1KiB", 1024, 100, 20),
    await benchOverwrite("100KiB", 100 * 1024, 100, 5),
    await benchOverwrite("5MiB", 5 * 1024 * 1024, 40, 1),
  ];

  const reads = [
    await benchRead("readFile-stream(100KiB)", 100 * 1024, 100, 20, async (db) => {
      await drain(await readFile(db, "/read.bin"));
    }),
    await benchRead("readFile-stream(5MiB)", 5 * 1024 * 1024, 100, 5, async (db) => {
      await drain(await readFile(db, "/read.bin"));
    }),
    await benchRead("readFile-utf8(100KiB)", 100 * 1024, 100, 10, async (db) => {
      await readFile(db, "/read.bin", "utf8");
    }),
    await benchRead("readRange(4KiB)", 5 * 1024 * 1024, 100, 200, (db) => {
      readRangeSync(db, "/read.bin", CHUNK_SIZE + 4096, 4096);
    }),
  ];

  const lines: string[] = [];
  lines.push("=".repeat(88));
  lines.push("dofs overwrite and read latency — backend: REAL Durable Object SqlStorage");
  lines.push("=".repeat(88));
  lines.push("");
  lines.push("OVERWRITE (every chunk changes on every save)");
  lines.push(
    `${"operation".padEnd(20)}${"saves".padStart(7)}${"batch".padStart(7)}${"p50".padStart(11)}${"p99".padStart(11)}${"blobs".padStart(8)}${"manifests".padStart(11)}${"db MiB".padStart(10)}`,
  );
  lines.push("-".repeat(85));
  for (const o of overwrites) {
    lines.push(
      `${o.name.padEnd(20)}${String(o.saves).padStart(7)}${String(o.batch).padStart(7)}${ms(o.p50Ms).padStart(11)}${ms(o.p99Ms).padStart(11)}${String(o.blobs).padStart(8)}${String(o.manifests).padStart(11)}${o.databaseMiB.toFixed(2).padStart(10)}`,
    );
  }
  lines.push("");
  lines.push("READ");
  lines.push(
    `${"operation".padEnd(26)}${"iters".padStart(7)}${"batch".padStart(7)}${"p50".padStart(11)}${"p99".padStart(11)}`,
  );
  lines.push("-".repeat(62));
  for (const r of reads) {
    lines.push(
      `${r.name.padEnd(26)}${String(r.iters).padStart(7)}${String(r.batch).padStart(7)}${ms(r.p50Ms).padStart(11)}${ms(r.p99Ms).padStart(11)}`,
    );
  }
  lines.push("");
  lines.push("JSON");
  lines.push(JSON.stringify({ backend: "durable-object-sqlstorage", overwrites, reads }));
  lines.push("=".repeat(88));
  console.log(`\n${lines.join("\n")}\n`);
});
