import { describe, expect, it } from "vitest";

import type { Database } from "../storage";
import {
  deleteNode,
  dropChunks,
  linkChunk,
  openReapDeferral,
  reapsDeferred,
  replaceChunk,
  setNodeManifest,
} from "./refs";
import { withDB } from "./with-db";

function hashOf(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function fileNode(db: Database): number {
  const row = db.one<{ inode: number }>(
    "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0) RETURNING inode",
  );
  if (row === undefined) throw new Error("no inode");
  return row.inode;
}

function chunkRows(db: Database, inode: number): Array<{ idx: number; first: number }> {
  return db
    .all<{ idx: number; hash: Uint8Array }>(
      "SELECT idx, hash FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      inode,
    )
    .map((row) => ({ idx: row.idx, first: row.hash[0] }));
}

describe("chunk reference helpers", () => {
  it("links chunks at their index", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      db.transactionSync(() => {
        linkChunk(db, inode, 0, hashOf(1), 10);
        linkChunk(db, inode, 1, hashOf(2), 10);
      });
      expect(chunkRows(db, inode)).toEqual([
        { idx: 0, first: 1 },
        { idx: 1, first: 2 },
      ]);
    });
  });

  it("replaces the chunk at one index and leaves the others", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      db.transactionSync(() => {
        linkChunk(db, inode, 0, hashOf(1), 10);
        linkChunk(db, inode, 1, hashOf(2), 10);
        replaceChunk(db, inode, 1, hashOf(3), 10, hashOf(2));
      });
      expect(chunkRows(db, inode)).toEqual([
        { idx: 0, first: 1 },
        { idx: 1, first: 3 },
      ]);
    });
  });

  it("drops every chunk of an inode and returns their hashes", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      const other = fileNode(db);
      const dropped = db.transactionSync(() => {
        linkChunk(db, inode, 0, hashOf(1), 10);
        linkChunk(db, inode, 1, hashOf(2), 10);
        linkChunk(db, other, 0, hashOf(1), 10);
        return dropChunks(db, inode);
      });
      expect(dropped.map((hash) => hash[0]).sort()).toEqual([1, 2]);
      expect(chunkRows(db, inode)).toEqual([]);
      expect(chunkRows(db, other)).toEqual([{ idx: 0, first: 1 }]);
    });
  });

  it("drops only the tail from a given index", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      const dropped = db.transactionSync(() => {
        for (let idx = 0; idx < 4; idx++) linkChunk(db, inode, idx, hashOf(idx + 1), 10);
        return dropChunks(db, inode, 2);
      });
      expect(dropped.map((hash) => hash[0]).sort()).toEqual([3, 4]);
      expect(chunkRows(db, inode)).toEqual([
        { idx: 0, first: 1 },
        { idx: 1, first: 2 },
      ]);
    });
  });
});

describe("node manifest helpers", () => {
  it("sets a file's metadata and manifest in one update", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      db.transactionSync(() => {
        setNodeManifest(db, inode, hashOf(9), { mode: 0o600, mtime: 5, rev: 7, size: 20 });
      });
      const row = db.one<{
        mode: number;
        mtime: number;
        rev: number;
        size: number;
        manifest_hash: Uint8Array | null;
      }>("SELECT mode, mtime, rev, size, manifest_hash FROM vfs_nodes WHERE inode = ?", inode);
      expect(row).toMatchObject({ mode: 0o600, mtime: 5, rev: 7, size: 20 });
      expect(row?.manifest_hash?.[0]).toBe(9);

      db.transactionSync(() => {
        setNodeManifest(db, inode, null, { mode: 0o600, mtime: 6, rev: 8, size: 0 });
      });
      expect(
        db.scalar<Uint8Array | null>("SELECT manifest_hash FROM vfs_nodes WHERE inode = ?", inode),
      ).toBeNull();
    });
  });

  it("deletes a node row", async () => {
    await withDB((db) => {
      const inode = fileNode(db);
      db.transactionSync(() => deleteNode(db, inode));
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_nodes WHERE inode = ?", inode)).toBe(0);
    });
  });
});

describe("reap deferral", () => {
  it("defers reaps only inside hold", async () => {
    await withDB((db) => {
      const deferral = openReapDeferral(db);
      expect(reapsDeferred(db)).toBe(false);
      const inside = deferral.hold(() => reapsDeferred(db));
      expect(inside).toBe(true);
      expect(reapsDeferred(db)).toBe(false);
      deferral.close();
    });
  });

  it("ignores a second close", async () => {
    await withDB((db) => {
      const deferral = openReapDeferral(db);
      deferral.close();
      expect(() => deferral.close()).not.toThrow();
    });
  });
});
