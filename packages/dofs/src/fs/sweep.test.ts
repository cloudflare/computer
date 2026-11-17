import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../storage";
import { stageBlob } from "../sync/blobs";
import { buildManifest } from "../sync/manifests";
import { gc } from "./gc";
import { pinHashes } from "./pins";
import { readFile } from "./readFile";
import {
  BACKGROUND_REAP_BYTES_PER_WRITE,
  isDeferred,
  openReapDeferral,
  SWEEP_GRACE_MS,
  SWEEP_ROWS_PER_WRITE,
} from "./refs";
import { withDB } from "./with-db";
import { CHUNK_SIZE, writeFile, writeFileSync } from "./writeFile";

const NOW = (): number => 1000;
const HOUR = 60 * 60 * 1000;

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function count(db: Database, table: string): number {
  return db.scalar<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0;
}

// Leave an unreferenced blob and manifest behind, the way an abandoned
// sync, a failed streaming write or an older release did.
// last_seen is the wall clock at staging, so the clock is set to
// `lastSeen` for the staging and put back afterwards.
function leaveOrphan(db: Database, label: string, lastSeen: number): Uint8Array {
  const bytes = new TextEncoder().encode(`orphan ${label}`);
  const hash = sha256(bytes);
  const now = Date.now();
  vi.setSystemTime(lastSeen);
  stageBlob(db, hash, bytes);
  db.transactionSync(() => buildManifest(db, [{ hash, size: bytes.byteLength }]));
  vi.setSystemTime(now);
  return hash;
}

function hasBlob(db: Database, hash: Uint8Array): boolean {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs WHERE hash = ?", hash) === 1;
}

let saves = 0;
function write(db: Database): void {
  writeFileSync(db, "/busy.txt", new TextEncoder().encode(`save ${saves++}`), {}, NOW);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("incremental sweep", () => {
  it("drains a backlog of old orphans as writes happen, with no migration", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/keep.txt", new TextEncoder().encode("live"), {}, NOW);
      const old = Date.now() - 2 * HOUR;
      for (let i = 0; i < 40; i++) leaveOrphan(db, String(i), old);
      expect(count(db, "vfs_blobs")).toBe(41);

      // Each write checks a few rows of one table, alternating, so one
      // full pass over both takes about twice the rows over K writes.
      const writes = 2 * Math.ceil(45 / SWEEP_ROWS_PER_WRITE) + 2;
      for (let i = 0; i < writes; i++) write(db);

      expect(count(db, "vfs_blobs")).toBe(2);
      expect(count(db, "vfs_manifests")).toBe(2);
      expect(await readFile(db, "/keep.txt", "utf8")).toBe("live");
      expect(gc(db, { safetyWindowMs: 0, now: () => Number.MAX_SAFE_INTEGER })).toEqual({
        blobsFreed: 0,
        manifestsFreed: 0,
      });
    });
  });

  it("reclaims a bounded number of rows per write", async () => {
    await withDB((db) => {
      const old = Date.now() - 2 * HOUR;
      for (let i = 0; i < 3 * SWEEP_ROWS_PER_WRITE; i++) leaveOrphan(db, String(i), old);
      const before = count(db, "vfs_blobs");

      write(db);

      expect(before - count(db, "vfs_blobs")).toBeLessThanOrEqual(SWEEP_ROWS_PER_WRITE);
    });
  });

  it("leaves staging inside the grace window alone", async () => {
    await withDB((db) => {
      const fresh = leaveOrphan(db, "in flight", Date.now());
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, fresh)).toBe(true);

      vi.advanceTimersByTime(SWEEP_GRACE_MS + 1);
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, fresh)).toBe(false);
    });
  });

  it("leaves pinned blobs alone", async () => {
    await withDB((db) => {
      const held = leaveOrphan(db, "held", Date.now() - 2 * HOUR);
      const pin = pinHashes(db, [held]);
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, held)).toBe(true);

      pin.release();
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, held)).toBe(false);
    });
  });

  it("keeps sweeping while a sync apply is open", async () => {
    await withDB((db) => {
      // Staging is stamped with the wall clock, so an apply in progress
      // does not need the sweep to stand still.
      const old = leaveOrphan(db, "long abandoned", Date.now() - 2 * HOUR);
      const deferral = openReapDeferral(db);
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, old)).toBe(false);
      deferral.close();
    });
  });

  it("comes back round to rows behind its cursor", async () => {
    await withDB((db) => {
      for (let i = 0; i < 30; i++) {
        writeFileSync(db, `/f${i}`, new TextEncoder().encode(`file ${i}`), {}, NOW);
      }
      for (let i = 0; i < 20; i++) write(db);

      // An older release dropped a reference without reclaiming it. The
      // blob sits at a low rowid the cursor has already passed.
      const hash = sha256(new TextEncoder().encode("file 0"));
      db.run("DELETE FROM vfs_dirents WHERE parent_inode = 1 AND name = 'f0'");
      db.run("DELETE FROM vfs_chunks WHERE hash = ?", hash);
      db.run("UPDATE vfs_blobs SET last_seen = ? WHERE hash = ?", Date.now() - 2 * HOUR, hash);

      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, hash)).toBe(false);
    });
  });
});

// A streaming write whose source fails after one full window, leaving
// that window staged and never linked.
async function abandonStreamingWrite(
  db: Database,
  fill: number,
  now: () => number,
): Promise<Uint8Array> {
  const window = new Uint8Array(CHUNK_SIZE).fill(fill);
  let sent = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ === 0) controller.enqueue(window);
      else controller.error(new Error("source broke"));
    },
  });
  await expect(writeFile(db, `/abandoned-${fill}`, source, {}, now)).rejects.toThrow(
    "source broke",
  );
  return sha256(window);
}

describe("last_seen", () => {
  it("is the wall clock when dofs wrote the row, whatever clock the write was given", async () => {
    await withDB((db) => {
      const bytes = new TextEncoder().encode("stamped");
      writeFileSync(db, "/a.txt", bytes, {}, () => 1);
      const staged = new TextEncoder().encode("staged");
      stageBlob(db, sha256(staged), staged);

      const blobs = db.all<{ last_seen: number }>("SELECT last_seen FROM vfs_blobs");
      const manifests = db.all<{ last_seen: number }>("SELECT last_seen FROM vfs_manifests");
      expect(blobs.map((row) => row.last_seen)).toEqual([Date.now(), Date.now()]);
      expect(manifests.map((row) => row.last_seen)).toEqual([Date.now()]);
    });
  });

  it("sweeps abandoned staging from a writer whose clock runs ahead", async () => {
    await withDB(async (db) => {
      const tenYears = 10 * 365 * 24 * HOUR;
      const staged = await abandonStreamingWrite(db, 1, () => Date.now() + tenYears);

      vi.advanceTimersByTime(SWEEP_GRACE_MS + 1);
      for (let i = 0; i < 20; i++) write(db);

      expect(hasBlob(db, staged)).toBe(false);
    });
  });

  it("keeps fresh staging from a writer whose clock runs behind", async () => {
    await withDB(async (db) => {
      const staged = await abandonStreamingWrite(db, 2, () => 1);

      for (let i = 0; i < 20; i++) write(db);

      expect(hasBlob(db, staged)).toBe(true);
    });
  });
});

describe("work a write does for earlier writes", () => {
  // A full chunk of distinct content.
  function chunk(fill: number): Uint8Array {
    return new Uint8Array(CHUNK_SIZE).fill(fill);
  }

  function blobBytes(db: Database): number {
    return db.scalar<number>("SELECT COALESCE(SUM(size), 0) FROM vfs_blobs") ?? 0;
  }

  it("sweeps at most one chunk's worth of old staging per write", async () => {
    await withDB((db) => {
      const now = Date.now();
      vi.setSystemTime(now - 2 * HOUR);
      for (let i = 1; i <= SWEEP_ROWS_PER_WRITE; i++) stageBlob(db, sha256(chunk(i)), chunk(i));
      vi.setSystemTime(now);
      const before = blobBytes(db);

      write(db);

      const freed = before - blobBytes(db);
      expect(freed).toBeGreaterThan(0);
      expect(freed).toBeLessThanOrEqual(BACKGROUND_REAP_BYTES_PER_WRITE);

      // The rest goes on later writes; the cursor does not skip it.
      for (let i = 0; i < 4 * SWEEP_ROWS_PER_WRITE; i++) write(db);
      expect(count(db, "vfs_blobs")).toBe(1);
    });
  });

  it("retries at most one chunk's worth of deferred content per write", async () => {
    await withDB((db) => {
      const pins = [];
      for (let i = 1; i <= 4; i++) {
        writeFileSync(db, `/big${i}`, chunk(i), {}, NOW);
        pins.push(pinHashes(db, [sha256(chunk(i))]));
        writeFileSync(db, `/big${i}`, new TextEncoder().encode("small now"), {}, NOW);
      }
      for (const pin of pins) pin.release();
      expect([1, 2, 3, 4].every((i) => isDeferred(db, sha256(chunk(i))))).toBe(true);

      write(db);

      const left = [1, 2, 3, 4].filter((i) => hasBlob(db, sha256(chunk(i))));
      expect(left.length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < 8; i++) write(db);
      expect([1, 2, 3, 4].some((i) => hasBlob(db, sha256(chunk(i))))).toBe(false);
    });
  });
});
