import { describe, expect, it } from "vitest";

import { withDB } from "../fs/with-db";
import { writeFile } from "../fs/writeFile";

describe("manifests", () => {
  it("writeFile sets vfs_nodes.manifest_hash to a non-null hash", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/hello.txt", "hello", {}, () => 1);
      const row = db.one<{ manifest_hash: Uint8Array | null }>(
        "SELECT manifest_hash FROM vfs_nodes WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE parent_inode = 1 AND name = 'hello.txt')",
      );
      expect(row?.manifest_hash).toBeInstanceOf(Uint8Array);
      expect(row?.manifest_hash?.byteLength).toBe(32);
    });
  });

  it("identical content at two paths shares one manifest row", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "same bytes", {}, () => 1);
      await writeFile(db, "/b.txt", "same bytes", {}, () => 1);
      const count = db.scalar<number>("SELECT COUNT(*) AS n FROM vfs_manifests");
      expect(count).toBe(1);
      // Both inodes point at the same manifest_hash.
      const hashes = db.all<{ manifest_hash: Uint8Array | null }>(
        "SELECT manifest_hash FROM vfs_nodes WHERE type = 'file' ORDER BY inode",
      );
      expect(hashes).toHaveLength(2);
      expect(hashes[0].manifest_hash).toEqual(hashes[1].manifest_hash);
    });
  });

  it("different content produces different manifest hashes", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "one", {}, () => 1);
      await writeFile(db, "/b.txt", "two", {}, () => 1);
      const count = db.scalar<number>("SELECT COUNT(*) AS n FROM vfs_manifests");
      expect(count).toBe(2);
    });
  });

  it("vfs_manifests row carries the chunk list as JSON", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/hi.txt", "hi", {}, () => 1);
      const row = db.one<{ encoded: Uint8Array; size: number }>(
        "SELECT encoded, size FROM vfs_manifests LIMIT 1",
      );
      expect(row).toBeDefined();
      expect(row?.size).toBe(2);
      const decoded = JSON.parse(new TextDecoder().decode(row?.encoded));
      expect(decoded.version).toBe(1);
      expect(decoded.chunks).toHaveLength(1);
      expect(decoded.chunks[0].size).toBe(2);
      expect(typeof decoded.chunks[0].hash).toBe("string");
      expect(decoded.chunks[0].hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("overwriting a file updates manifest_hash and may leave the old manifest orphaned", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1);
      const before = db.one<{ manifest_hash: Uint8Array | null }>(
        "SELECT manifest_hash FROM vfs_nodes WHERE type = 'file'",
      );
      await writeFile(db, "/x.txt", "second", {}, () => 2);
      const after = db.one<{ manifest_hash: Uint8Array | null }>(
        "SELECT manifest_hash FROM vfs_nodes WHERE type = 'file'",
      );
      expect(after?.manifest_hash).not.toEqual(before?.manifest_hash);
      // Two manifest rows now exist; the old one is orphaned and will
      // be reaped by gc().
      const count = db.scalar<number>("SELECT COUNT(*) AS n FROM vfs_manifests");
      expect(count).toBe(2);
    });
  });
});
