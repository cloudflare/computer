import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../storage";
import { applyChanges } from "../sync/apply";
import { stageBlob } from "../sync/blobs";
import type { ChangeEntry } from "../sync/changes";
import { hasObjects } from "../sync/fetch";
import { hashKey } from "./blobCache";
import { gc } from "./gc";
import { link } from "./link";
import { mkdir } from "./mkdir";
import { HAS_OBJECTS_PIN_MS, isPinned } from "./pins";
import { readFile, readRangeSync } from "./readFile";
import { isDeferred, SWEEP_GRACE_MS, SWEEP_ROWS_PER_WRITE } from "./refs";
import { rename } from "./rename";
import { resolveInode } from "./resolve";
import { rm } from "./rm";
import { withDB } from "./with-db";
import {
  CHUNK_SIZE,
  chunksOf,
  openWriteBufferSync,
  releaseWriteBufferSync,
  truncateFileSync,
  writeFile,
  writeFileSync,
  writeRangeSync,
} from "./writeFile";

// Random sequences of every operation that adds or drops a reference,
// interleaved with sync applies, staging, hasObjects probes and read
// streams opened, pulled and abandoned. After every step the store must
// hold the invariants reclamation promises:
//
//   * every chunk and manifest a node references is present;
//   * what gc() would still free is only what is pinned, deferred, or
//     staged and never linked;
//   * once nothing is pinned and the sweep has gone round, gc() finds
//     nothing at all;
//   * a read stream returns the file as it was when it opened.

const NOW = (): number => 1000;
const PATHS = ["/a", "/b", "/c", "/d/e"];
const STEPS = 250;
const REFUSALS = new Set(["ENOENT", "EISDIR", "ENOTDIR", "EEXIST", "EPERM", "ENOTEMPTY", "EINVAL"]);

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// Small deterministic generator, so a failure reproduces from its seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function contents(): Uint8Array[] {
  const small = ["alpha", "beta", "gamma", "alpha", "delta delta", ""].map((text) =>
    new TextEncoder().encode(text),
  );
  // Two large files that share their first chunk.
  const first = new Uint8Array(CHUNK_SIZE + 7).fill(1);
  const second = new Uint8Array(CHUNK_SIZE + 9).fill(1);
  second.fill(2, CHUNK_SIZE);
  return [...small, first, second];
}

interface OpenStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  expected: string;
  parts: Uint8Array[];
}

function fileBytes(db: Database, path: string): Uint8Array | undefined {
  const node = resolveInode(db, path);
  if (node?.type !== "file") return undefined;
  return readRangeSync(db, path, 0, node.size);
}

function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function count(db: Database, table: string): number {
  return db.scalar<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0;
}

function scratch(db: Database, i: number): void {
  writeFileSync(db, "/scratch", new TextEncoder().encode(`scratch ${i}`), {}, NOW);
}

function assertReferencesPresent(db: Database): void {
  expect(
    db.scalar<number>(
      `SELECT COUNT(*) FROM vfs_chunks c
        WHERE NOT EXISTS (SELECT 1 FROM vfs_blob_bytes b WHERE b.hash = c.hash)`,
    ),
    "chunks without bytes",
  ).toBe(0);
  expect(
    db.scalar<number>(
      `SELECT COUNT(*) FROM vfs_nodes n
        WHERE n.manifest_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vfs_manifests m WHERE m.hash = n.manifest_hash)`,
    ),
    "nodes without their manifest",
  ).toBe(0);
  expect(
    db.scalar<number>(
      `SELECT COUNT(*) FROM vfs_blob_bytes bb
        WHERE NOT EXISTS (SELECT 1 FROM vfs_blobs b WHERE b.hash = bb.hash)`,
    ),
    "bytes without their blob row",
  ).toBe(0);
}

// What gc() would free with no safety window, by the same predicates
// it uses. gc() itself deletes, so it runs once, at the end.
function orphans(db: Database): { blobs: Uint8Array[]; manifests: number } {
  const blobs = db
    .all<{ hash: Uint8Array }>(
      `SELECT hash FROM vfs_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)`,
    )
    .map((row) => row.hash);
  const manifests =
    db.scalar<number>(
      `SELECT COUNT(*) FROM vfs_manifests m
        WHERE NOT EXISTS (SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = m.hash)`,
    ) ?? 0;
  return { blobs, manifests };
}

async function runSequence(db: Database, seed: number): Promise<{ staged: Set<string> }> {
  const next = random(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
  const pool = contents();
  const streams: OpenStream[] = [];
  // Hashes staged on purpose and never linked: abandoned staging.
  const staged = new Set<string>();

  mkdir(db, "/d", {}, NOW);

  const ops: Array<() => Promise<void> | void> = [
    () => writeFileSync(db, pick(PATHS), pick(pool), {}, NOW),
    async () => {
      const bytes = pick(pool);
      const half = Math.floor(bytes.byteLength / 2);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, half));
          controller.enqueue(bytes.slice(half));
          controller.close();
        },
      });
      await writeFile(db, pick(PATHS), source, {}, NOW);
    },
    () => {
      const path = pick(PATHS);
      const size = fileBytes(db, path)?.byteLength ?? 0;
      writeRangeSync(db, path, new TextEncoder().encode("++"), size, {}, NOW);
    },
    () => {
      const path = pick(PATHS);
      const size = fileBytes(db, path)?.byteLength ?? 0;
      writeRangeSync(db, path, pick(pool).slice(0, 3), Math.floor(next() * (size + 1)), {}, NOW);
    },
    () => {
      const path = pick(PATHS);
      const size = fileBytes(db, path)?.byteLength ?? 0;
      truncateFileSync(db, path, pick([0, Math.floor(size / 2), size + 3]), NOW);
    },
    () => {
      const path = pick(PATHS);
      openWriteBufferSync(db, path);
      try {
        writeRangeSync(db, path, pick(pool).slice(0, 4), 0, {}, NOW);
      } finally {
        releaseWriteBufferSync(db, path, NOW);
      }
    },
    () => rm(db, pick(PATHS), { force: true }),
    () => rename(db, pick(PATHS), pick(PATHS)),
    () => link(db, pick(PATHS), pick(PATHS)),
    async () => {
      // A sync block: stage the bytes, then apply a delete and a file
      // that may reuse the deleted content, as a rename does.
      const bytes = pick(pool);
      const chunks = chunksOf(bytes);
      for (const chunk of chunks) stageBlob(db, chunk.hash, chunk.bytes, Date.now());
      const entries: ChangeEntry[] = [
        { kind: "delete", rev: 1, path: pick(PATHS) },
        {
          kind: "file",
          rev: 1,
          path: pick(PATHS),
          mode: 0o644,
          mtime: 1,
          size: bytes.byteLength,
          chunks: chunks.map(({ hash, size }) => ({ hash, size })),
        },
      ];
      await applyChanges(db, entries, new Map());
    },
    () => {
      const bytes = new TextEncoder().encode(`abandoned ${Math.floor(next() * 4)}`);
      const hash = sha256(bytes);
      if (db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs WHERE hash = ?", hash) === 0) {
        staged.add(hashKey(hash));
      }
      stageBlob(db, hash, bytes, Date.now());
    },
    async () => {
      const path = pick(PATHS);
      const current = fileBytes(db, path);
      if (current === undefined) return;
      const stream = await readFile(db, path);
      streams.push({ reader: stream.getReader(), expected: hex(sha256(current)), parts: [] });
    },
    async () => {
      const open = pick(streams);
      if (open === undefined) return;
      const { value, done } = await open.reader.read();
      if (!done) {
        open.parts.push(value);
        return;
      }
      expect(hex(sha256(joined(open.parts))), "stream saw the file as it opened").toBe(
        open.expected,
      );
      streams.splice(streams.indexOf(open), 1);
    },
    async () => {
      const open = pick(streams);
      if (open === undefined) return;
      await open.reader.cancel();
      streams.splice(streams.indexOf(open), 1);
    },
    () => {
      hasObjects(
        db,
        pool.flatMap((bytes) => chunksOf(bytes).map((chunk) => chunk.hash)),
      );
    },
    () => {
      vi.advanceTimersByTime(Math.floor(next() * 3 * 60 * 1000));
    },
  ];

  for (let step = 0; step < STEPS; step++) {
    const op = pick(ops);
    try {
      await op();
    } catch (error) {
      // Filesystem refusals (a missing path, a directory in the way)
      // are part of a random sequence. Anything else, missing bytes
      // included, is a bug.
      if (!REFUSALS.has((error as { code?: string }).code ?? "")) throw error;
    }

    assertReferencesPresent(db);
    const freeable = orphans(db);
    expect(freeable.manifests, `orphan manifests after step ${step}`).toBe(0);
    for (const hash of freeable.blobs) {
      const accounted = isPinned(db, hash) || isDeferred(db, hash) || staged.has(hashKey(hash));
      expect(accounted, `unaccounted orphan ${hex(hash)} after step ${step}`).toBe(true);
    }
  }

  for (const open of streams) await open.reader.cancel();
  return { staged };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reclamation invariants", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`holds across a random sequence (seed ${seed})`, async () => {
      await withDB(async (db) => {
        const { staged } = await runSequence(db, seed);

        // Once every pin has lapsed, a few writes reclaim everything that
        // was deferred, leaving only staging nothing linked.
        vi.advanceTimersByTime(HAS_OBJECTS_PIN_MS);
        for (let i = 0; i < 4; i++) scratch(db, i);
        const left = orphans(db);
        expect(left.manifests).toBe(0);
        expect(left.blobs.map(hashKey).filter((key) => !staged.has(key))).toEqual([]);

        // Past the staging grace, the sweep reclaims that too, given
        // enough writes to go round both tables.
        vi.advanceTimersByTime(SWEEP_GRACE_MS + 1);
        const rows = count(db, "vfs_blobs") + count(db, "vfs_manifests");
        for (let i = 0; i < 2 * Math.ceil(rows / SWEEP_ROWS_PER_WRITE) + 2; i++) scratch(db, i);
        expect(gc(db, { safetyWindowMs: 0, now: () => Number.MAX_SAFE_INTEGER })).toEqual({
          blobsFreed: 0,
          manifestsFreed: 0,
        });
      });
    });
  }
});
