import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../storage";
import { stageBlob } from "../sync/blobs";
import { buildManifest } from "../sync/manifests";
import { gc } from "./gc";
import { pinHashes } from "./pins";
import { readFile } from "./readFile";
import { openReapDeferral, SWEEP_GRACE_MS, SWEEP_ROWS_PER_WRITE } from "./refs";
import { withDB } from "./with-db";
import { writeFileSync } from "./writeFile";

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
function leaveOrphan(db: Database, label: string, lastSeen: number): Uint8Array {
  const bytes = new TextEncoder().encode(`orphan ${label}`);
  const hash = sha256(bytes);
  stageBlob(db, hash, bytes, lastSeen);
  db.transactionSync(() => buildManifest(db, [{ hash, size: bytes.byteLength }], lastSeen));
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

  it("does not sweep while reaps are deferred", async () => {
    await withDB((db) => {
      const staged = leaveOrphan(db, "about to link", Date.now() - 2 * HOUR);
      const deferral = openReapDeferral(db);
      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, staged)).toBe(true);
      deferral.close();

      for (let i = 0; i < 20; i++) write(db);
      expect(hasBlob(db, staged)).toBe(false);
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
