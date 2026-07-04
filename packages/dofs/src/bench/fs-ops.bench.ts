// dofs micro-benchmark harness.
//
// Runs under @cloudflare/vitest-pool-workers (see
// vitest.config.bench.ts) so every operation drives a REAL Durable
// Object SqlStorage. It deliberately does NOT use the node
// SQLiteTestStorage fixture: that backend caches prepared statements
// and would understate the per-statement cost this harness exists to
// measure.
//
// Each scenario is reported two ways:
//   * ns/op wall-clock, measured against the raw DO SqlStorage.
//   * statement + row counts, measured against the same backend
//     wrapped in CountingStorage. Statement counts are deterministic
//     and are the primary signal — a resolve is one statement
//     regardless of depth (fs.stat = 1, provider.statSync = 2), and the
//     cold-vs-warm group isolates the CTE cold walk from the cache hit.
//
// Output is a set of tables plus a single-line JSON blob so before/
// after deltas are easy to capture and diff. Run with:
//   npm run bench --workspace @cloudflare/dofs
// (or: npx vitest run --config vitest.config.bench.ts, from the
// package dir).

import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { TestBindings } from "../../tests/worker.js";
import { ls } from "../fs/ls.js";
import { resolveInode } from "../fs/resolve.js";
import { clearResolveCache } from "../fs/resolveCache.js";
import { rm } from "../fs/rm.js";
import { stat } from "../fs/stat.js";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import type { DurableObjectStorageLike } from "../types.js";
import { CountingStorage } from "./counting-storage.js";

const NOW = (): number => 1000;

interface RealStorage extends DurableObjectStorageLike {
  readonly databaseSize?: number;
}

function freshStub(): DurableObjectStub {
  const ns = (env as unknown as TestBindings).TestStorage;
  return ns.get(ns.newUniqueId());
}

// Raw real SqlStorage — used for clean wall-clock numbers with no
// counting overhead.
async function withRealDb<T>(
  fn: (db: Database, provider: SQLiteWorkspaceProvider, storage: RealStorage) => T,
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const storage = state.storage as unknown as DurableObjectStorageLike;
    const db = new Database(storage);
    initializeSchema(db, NOW);
    const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
    return fn(db, provider, (storage as { sql: RealStorage }).sql as unknown as RealStorage);
  });
}

// Counting wrapper over the same real backend — used for deterministic
// statement/row counts. Schema init is excluded via reset().
async function withCountingDb<T>(
  fn: (db: Database, provider: SQLiteWorkspaceProvider, counting: CountingStorage) => T,
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const counting = new CountingStorage(state.storage as unknown as DurableObjectStorageLike);
    const db = new Database(counting);
    initializeSchema(db, NOW);
    counting.reset();
    const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
    return fn(db, provider, counting);
  });
}

type Build = (db: Database, provider: SQLiteWorkspaceProvider) => void;
type Op = (db: Database, provider: SQLiteWorkspaceProvider) => void;

interface ReadResult {
  name: string;
  depth: number;
  nsPerOp: number;
  statements: number;
  reads: number;
  writes: number;
}

interface MutationResult {
  name: string;
  items: number;
  totalMs: number;
  nsPerItem: number;
  statements: number;
  reads: number;
  writes: number;
  rowsWritten: number;
}

// Repeatable read op: build the tree once, then time `op` over `iters`.
async function benchRead(
  name: string,
  depth: number,
  build: Build,
  op: Op,
  iters: number,
): Promise<ReadResult> {
  const warmup = Math.min(200, iters);
  const nsPerOp = await withRealDb((db, provider) => {
    build(db, provider);
    for (let i = 0; i < warmup; i++) {
      op(db, provider);
    }
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      op(db, provider);
    }
    const t1 = performance.now();
    return ((t1 - t0) * 1e6) / iters;
  });
  const counts = await withCountingDb((db, provider, counting) => {
    build(db, provider);
    counting.reset();
    op(db, provider);
    return counting.snapshot();
  });
  return {
    name,
    depth,
    nsPerOp,
    statements: counts.statements,
    reads: counts.reads,
    writes: counts.writes,
  };
}

// One-shot mutation batch: build fresh state, run the whole batch once,
// report totals and per-item amortized cost.
async function benchMutation(
  name: string,
  build: Build,
  batch: (db: Database, provider: SQLiteWorkspaceProvider) => number,
): Promise<MutationResult> {
  const timing = await withRealDb((db, provider) => {
    build(db, provider);
    const t0 = performance.now();
    const items = batch(db, provider);
    const t1 = performance.now();
    return { totalMs: t1 - t0, items };
  });
  const counts = await withCountingDb((db, provider, counting) => {
    build(db, provider);
    counting.reset();
    batch(db, provider);
    return counting.snapshot();
  });
  const items = Math.max(1, timing.items);
  return {
    name,
    items: timing.items,
    totalMs: timing.totalMs,
    nsPerItem: (timing.totalMs * 1e6) / items,
    statements: counts.statements,
    reads: counts.reads,
    writes: counts.writes,
    rowsWritten: counts.rowsWritten,
  };
}

// --- path helpers -------------------------------------------------

function chainOf(depth: number): { dir: string | null; file: string } {
  const segs = Array.from({ length: depth }, (_, i) => `s${i + 1}`);
  const file = `/${segs.join("/")}`;
  const dir = depth > 1 ? `/${segs.slice(0, -1).join("/")}` : null;
  return { dir, file };
}

function buildChainFile(provider: SQLiteWorkspaceProvider, depth: number, content = "x"): string {
  const { dir, file } = chainOf(depth);
  if (dir !== null) {
    provider.mkdirSync(dir, { recursive: true });
  }
  provider.writeFileSync(file, content);
  return file;
}

// --- formatting ---------------------------------------------------

function ns(value: number): string {
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(3)}ms`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)}\u00b5s`;
  }
  return `${value.toFixed(0)}ns`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function padEnd(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

// ------------------------------------------------------------------

it("dofs micro-benchmark (real DO SqlStorage)", async () => {
  const lines: string[] = [];
  const readResults: ReadResult[] = [];
  const mutationResults: MutationResult[] = [];

  const depths = [1, 2, 4, 8, 16, 20];

  // Group A — path-resolution depth sweep, both stat surfaces + a
  // flat single-lookup baseline that should stay constant.
  for (const depth of depths) {
    readResults.push(
      await benchRead(
        "fs.stat",
        depth,
        (_db, provider) => {
          buildChainFile(provider, depth);
        },
        (db) => {
          stat(db, chainOf(depth).file);
        },
        4000,
      ),
    );
    readResults.push(
      await benchRead(
        "provider.statSync",
        depth,
        (_db, provider) => {
          buildChainFile(provider, depth);
        },
        (_db, provider) => {
          provider.statSync(chainOf(depth).file);
        },
        4000,
      ),
    );
    const holder = { inode: 0 };
    readResults.push(
      await benchRead(
        "flat-baseline(inode)",
        depth,
        (db, provider) => {
          const file = buildChainFile(provider, depth);
          holder.inode = resolveInode(db, file)?.inode ?? 0;
        },
        (db) => {
          db.one(
            "SELECT inode, type, mode, mtime, size FROM vfs_nodes WHERE inode = ?",
            holder.inode,
          );
        },
        4000,
      ),
    );
  }

  // Group B — exists, present vs missing leaf, at two depths.
  for (const depth of [8, 16]) {
    readResults.push(
      await benchRead(
        "exists(present)",
        depth,
        (_db, provider) => {
          buildChainFile(provider, depth);
        },
        (_db, provider) => {
          provider.existsSync(chainOf(depth).file);
        },
        4000,
      ),
    );
    readResults.push(
      await benchRead(
        "exists(missing)",
        depth,
        (_db, provider) => {
          const { dir } = chainOf(depth);
          if (dir !== null) {
            provider.mkdirSync(dir, { recursive: true });
          }
        },
        (_db, provider) => {
          provider.existsSync(chainOf(depth).file);
        },
        4000,
      ),
    );
  }

  // Group C — read paths at a representative depth.
  {
    const depth = 8;
    const content = "x".repeat(4096);
    readResults.push(
      await benchRead(
        "readFile(4KiB)",
        depth,
        (_db, provider) => {
          buildChainFile(provider, depth, content);
        },
        (_db, provider) => {
          provider.readFileSync(chainOf(depth).file, "utf8");
        },
        2000,
      ),
    );
    readResults.push(
      await benchRead(
        "readRange(1KiB)",
        depth,
        (_db, provider) => {
          buildChainFile(provider, depth, content);
        },
        (_db, provider) => {
          provider.readRangeSync(chainOf(depth).file, 0, 1024);
        },
        2000,
      ),
    );
  }

  // Group D — directory listing: readdir (single dir) vs ls (resolves
  // the prefix to its inode, then walks that subtree).
  {
    const width = 200;
    const buildWide: Build = (_db, provider) => {
      provider.mkdirSync("/wide", { recursive: true });
      for (let i = 0; i < width; i++) {
        provider.writeFileSync(`/wide/f${i}.txt`, "x");
      }
    };
    readResults.push(
      await benchRead(
        `readdir(${width})`,
        1,
        buildWide,
        (_db, provider) => {
          provider.readdirSync("/wide");
        },
        1000,
      ),
    );
    readResults.push(
      await benchRead(
        `ls(${width})`,
        1,
        buildWide,
        (db) => {
          ls(db, "/wide");
        },
        500,
      ),
    );
  }

  // Group E — recursive delete of a populated tree.
  {
    const files = 2000;
    mutationResults.push(
      await benchMutation(
        `recursive-delete(${files})`,
        (_db, provider) => {
          provider.mkdirSync("/tree", { recursive: true });
          for (let i = 0; i < files; i++) {
            provider.writeFileSync(`/tree/f${i}.txt`, "x");
          }
        },
        (db) => {
          rm(db, "/tree", { recursive: true, force: true });
          return files;
        },
      ),
    );
  }

  // Group F — write-heavy burst (agent edit session): create, then
  // edit-in-place (overwrite), then delete N files at depth.
  {
    const depth = 8;
    const count = 1000;
    const { dir } = chainOf(depth);
    const base = dir ?? "";
    const ensureDir: Build = (_db, provider) => {
      if (dir !== null) {
        provider.mkdirSync(dir, { recursive: true });
      }
    };
    const createAll = (provider: SQLiteWorkspaceProvider, value: string): void => {
      for (let i = 0; i < count; i++) {
        provider.writeFileSync(`${base}/burst${i}.txt`, value);
      }
    };
    mutationResults.push(
      await benchMutation(`write-burst:create(${count})`, ensureDir, (_db, provider) => {
        createAll(provider, "x");
        return count;
      }),
    );
    mutationResults.push(
      await benchMutation(
        `write-burst:edit-in-place(${count})`,
        (_db, provider) => {
          ensureDir(_db, provider);
          createAll(provider, "x");
        },
        (_db, provider) => {
          createAll(provider, "yy");
          return count;
        },
      ),
    );
    mutationResults.push(
      await benchMutation(
        `write-burst:delete(${count})`,
        (_db, provider) => {
          ensureDir(_db, provider);
          createAll(provider, "x");
        },
        (_db, provider) => {
          for (let i = 0; i < count; i++) {
            provider.unlinkSync(`${base}/burst${i}.txt`);
          }
          return count;
        },
      ),
    );
  }

  // Group G — rename: many single-file renames vs one subtree rename.
  {
    const count = 1000;
    mutationResults.push(
      await benchMutation(
        `single-rename(${count})`,
        (_db, provider) => {
          provider.mkdirSync("/mv", { recursive: true });
          for (let i = 0; i < count; i++) {
            provider.writeFileSync(`/mv/a${i}.txt`, "x");
          }
        },
        (_db, provider) => {
          for (let i = 0; i < count; i++) {
            provider.renameSync(`/mv/a${i}.txt`, `/mv/b${i}.txt`);
          }
          return count;
        },
      ),
    );
    const descendants = 500;
    mutationResults.push(
      await benchMutation(
        `subtree-rename(${descendants})`,
        (_db, provider) => {
          provider.mkdirSync("/sub/inner", { recursive: true });
          for (let i = 0; i < descendants; i++) {
            provider.writeFileSync(`/sub/inner/f${i}.txt`, "x");
          }
        },
        (_db, provider) => {
          provider.renameSync("/sub", "/moved");
          return descendants;
        },
      ),
    );
  }

  // Group H — DB size / dedup guard: 100 identical 1 MiB files should
  // dedup to ~1 MiB of blob bytes plus small metadata.
  const dedup = await withRealDb((_db, provider, storage) => {
    const oneMiB = "a".repeat(1024 * 1024);
    provider.mkdirSync("/dup", { recursive: true });
    for (let i = 0; i < 100; i++) {
      provider.writeFileSync(`/dup/f${i}.bin`, oneMiB);
    }
    return { bytes: storage.databaseSize ?? 0, files: 100, logicalMiB: 100 };
  });

  // Group I — cold vs warm resolve: isolate the CTE cold walk from the
  // cache hit. Cold clears the cache before every timed op (a fresh
  // single-statement CTE that reads D rows internally); warm leaves it
  // primed (a single readNode, O(1)). Same fs.stat, shallow and deep.
  interface ColdWarmResult {
    name: string;
    depth: number;
    coldNsPerOp: number;
    warmNsPerOp: number;
  }
  const coldWarmResults: ColdWarmResult[] = [];
  for (const depth of [4, 20]) {
    const measured = await withRealDb((db, provider) => {
      buildChainFile(provider, depth);
      const file = chainOf(depth).file;
      const iters = 4000;
      const warmup = 200;
      for (let i = 0; i < warmup; i++) {
        clearResolveCache(db);
        stat(db, file);
      }
      const cold0 = performance.now();
      for (let i = 0; i < iters; i++) {
        clearResolveCache(db);
        stat(db, file);
      }
      const cold1 = performance.now();
      for (let i = 0; i < warmup; i++) {
        stat(db, file);
      }
      const warm0 = performance.now();
      for (let i = 0; i < iters; i++) {
        stat(db, file);
      }
      const warm1 = performance.now();
      return {
        cold: ((cold1 - cold0) * 1e6) / iters,
        warm: ((warm1 - warm0) * 1e6) / iters,
      };
    });
    coldWarmResults.push({
      name: "fs.stat",
      depth,
      coldNsPerOp: measured.cold,
      warmNsPerOp: measured.warm,
    });
  }

  // --- render report ------------------------------------------------

  lines.push("=".repeat(96));
  lines.push(
    "dofs micro-benchmark — backend: REAL Durable Object SqlStorage (vitest-pool-workers)",
  );
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(
    "note: statement counts are deterministic; ns/op is wall-clock under workerd. " +
      "resolve = 1 statement (cold CTE or warm cache), depth-independent. " +
      "Depth-sweep ns/op below is cache-warm; see COLD-VS-WARM for the CTE cold walk.",
  );
  lines.push("=".repeat(96));

  lines.push("");
  lines.push("READ / RESOLVE OPS");
  lines.push(
    `${padEnd("operation", 22)}${pad("depth", 6)}${pad("ns/op", 12)}${pad("stmts", 8)}${pad("reads", 7)}${pad("writes", 8)}`,
  );
  lines.push("-".repeat(63));
  for (const r of readResults) {
    lines.push(
      `${padEnd(r.name, 22)}${pad(r.depth, 6)}${pad(ns(r.nsPerOp), 12)}${pad(r.statements, 8)}${pad(r.reads, 7)}${pad(r.writes, 8)}`,
    );
  }

  lines.push("");
  lines.push("MUTATION BATCHES (per-item amortized)");
  lines.push(
    `${padEnd("operation", 30)}${pad("items", 7)}${pad("total", 11)}${pad("ns/item", 12)}${pad("stmts", 8)}${pad("writes", 8)}${pad("rowsWr", 8)}`,
  );
  lines.push("-".repeat(84));
  for (const m of mutationResults) {
    lines.push(
      `${padEnd(m.name, 30)}${pad(m.items, 7)}${pad(`${m.totalMs.toFixed(1)}ms`, 11)}${pad(ns(m.nsPerItem), 12)}${pad(m.statements, 8)}${pad(m.writes, 8)}${pad(m.rowsWritten, 8)}`,
    );
  }

  lines.push("");
  lines.push("COLD (CTE walk) VS WARM (cached) RESOLVE — fs.stat");
  lines.push(
    `${padEnd("operation", 22)}${pad("depth", 6)}${pad("cold ns/op", 12)}${pad("warm ns/op", 12)}`,
  );
  lines.push("-".repeat(52));
  for (const c of coldWarmResults) {
    lines.push(
      `${padEnd(c.name, 22)}${pad(c.depth, 6)}${pad(ns(c.coldNsPerOp), 12)}${pad(ns(c.warmNsPerOp), 12)}`,
    );
  }

  lines.push("");
  lines.push("DB SIZE / DEDUP GUARD");
  lines.push(
    `100 x 1 MiB identical files -> logical ${dedup.logicalMiB} MiB, on-disk ${(dedup.bytes / (1024 * 1024)).toFixed(2)} MiB (${dedup.bytes} bytes)`,
  );

  lines.push("");
  lines.push("JSON");
  lines.push(
    JSON.stringify({
      backend: "durable-object-sqlstorage",
      reads: readResults,
      mutations: mutationResults,
      coldWarm: coldWarmResults,
      dedup,
    }),
  );
  lines.push("=".repeat(96));

  console.log(`\n${lines.join("\n")}\n`);

  // Signature gate. Statement counts are deterministic, so the O(depth)
  // fingerprint doubles as the harness's contract. Asserted AFTER the
  // report is printed so the numbers stay visible even when the gate
  // trips. A deliberate perf change is expected to update these, which
  // is the point — silent drift becomes a failure.
  //
  //   fs.stat           = 1  — one recursive-CTE resolve.
  //   provider.statSync = 2  — one resolve plus linkCount.
  //   flat-baseline     = 1  — a single indexed inode lookup.
  //
  // The CTE still reads O(depth) rows internally, but the statement
  // count — what the DO bills and round-trips — is depth-independent,
  // and a warm cache hit re-reads just the one node row.
  const find = (name: string, depth: number): ReadResult => {
    const row = readResults.find((r) => r.name === name && r.depth === depth);
    if (row === undefined) {
      throw new Error(`benchmark result missing: ${name} depth=${depth}`);
    }
    return row;
  };
  for (const depth of depths) {
    expect(find("fs.stat", depth).statements, `fs.stat depth=${depth}`).toBe(1);
    expect(find("provider.statSync", depth).statements, `provider.statSync depth=${depth}`).toBe(2);
    expect(find("flat-baseline(inode)", depth).statements, `flat-baseline depth=${depth}`).toBe(1);
  }
  // exists resolves in a single CTE statement too, whether the leaf is
  // present or missing.
  expect(find("exists(present)", 8).statements).toBe(1);
  expect(find("exists(missing)", 8).statements).toBe(1);
  // Dedup guarantee: 100 identical 1 MiB files must not balloon the DB.
  expect(dedup.bytes).toBeLessThan(2 * 1024 * 1024);
});
