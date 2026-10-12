import { describe, expect, it } from "vitest";
import { mkdir } from "../fs/mkdir.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { materialiseChange } from "./changes.js";

describe("materialiseChange", () => {
  it("returns a file entry with chunk hashes for a written file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/hello.txt", "hello world", { mode: 0o644 }, () => 1234);
      const entry = materialiseChange(db, "/hello.txt");
      expect(entry).toMatchObject({
        kind: "file",
        path: "/hello.txt",
        mode: 0o644,
        mtime: 1234,
        size: 11,
      });
      if (entry?.kind !== "file") throw new Error("expected file");
      expect(entry.rev).toBeGreaterThan(0);
      if (entry?.kind !== "file") throw new Error("expected file");
      expect(entry.chunks).toHaveLength(1);
      expect(entry.chunks[0].size).toBe(11);
      expect(entry.chunks[0].hash).toBeInstanceOf(Uint8Array);
      expect(entry.chunks[0].hash.byteLength).toBe(32);
    });
  });

  it("returns a dir entry for a created directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/sub", { mode: 0o755 }, () => 999);
      expect(materialiseChange(db, "/sub")).toEqual({
        kind: "dir",
        rev: expect.any(Number),
        path: "/sub",
        mode: 0o755,
        mtime: 999,
      });
    });
  });

  it("returns a symlink entry for a symlink", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target.txt", "x", {}, () => 1);
      symlink(db, "/target.txt", "/link", () => 2);
      expect(materialiseChange(db, "/link")).toEqual({
        kind: "symlink",
        rev: expect.any(Number),
        path: "/link",
        target: "/target.txt",
        // chmod on a symlink itself is platform-specific; we record
        // whatever symlink() stamped on vfs_nodes.
        mode: expect.any(Number),
        mtime: 2,
      });
    });
  });

  it("returns a delete entry for a tombstoned path", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/gone.txt", "bye", {}, () => 1);
      rm(db, "/gone.txt", {});
      expect(materialiseChange(db, "/gone.txt")).toEqual({
        kind: "delete",
        rev: expect.any(Number),
        path: "/gone.txt",
        prior: expect.any(String),
      });
    });
  });

  it("returns null for a path that was never written and has no tombstone", async () => {
    await withDB(async (db) => {
      expect(materialiseChange(db, "/never")).toBeNull();
    });
  });

  it("size reflects the sum of chunk sizes", async () => {
    await withDB(async (db) => {
      // Force two chunks: 600 KiB > CHUNK_SIZE (512 KiB).
      const bytes = new Uint8Array(600 * 1024);
      for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i & 0xff;
      await writeFile(db, "/big.bin", bytes, {}, () => 1);
      const entry = materialiseChange(db, "/big.bin");
      if (entry?.kind !== "file") throw new Error("expected file");
      expect(entry.chunks).toHaveLength(2);
      expect(entry.size).toBe(600 * 1024);
      expect(entry.chunks[0].size + entry.chunks[1].size).toBe(600 * 1024);
    });
  });
});
