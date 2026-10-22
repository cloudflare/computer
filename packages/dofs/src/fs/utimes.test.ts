import { describe, expect, it } from "vitest";

import { mkdir } from "./mkdir";
import { invalidateReadOnlyMountCache } from "./mount-guard";
import { lstat, stat } from "./stat";
import { symlink } from "./symlink";
import { utimes } from "./utimes";
import { withDB } from "./with-db";
import {
  openWriteBufferForCreateSync,
  openWriteBufferSync,
  releaseWriteBufferSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("utimes", () => {
  it("sets a file's modification time and bumps its rev", async () => {
    await withDB((db) => {
      writeFileSync(db, "/f", bytes("x"), {}, () => 5);
      const rev = db.scalar<number>(
        "SELECT rev FROM vfs_nodes WHERE inode = ?",
        stat(db, "/f").inode,
      );
      utimes(db, "/f", 1_000_000);
      expect(stat(db, "/f").mtime).toBe(1_000_000);
      const after = db.scalar<number>(
        "SELECT rev FROM vfs_nodes WHERE inode = ?",
        stat(db, "/f").inode,
      );
      expect(after).toBeGreaterThan(rev ?? 0);
    });
  });

  it("follows a symlink to its target", async () => {
    await withDB((db) => {
      writeFileSync(db, "/target", bytes("x"), {}, () => 5);
      symlink(db, "target", "/link", () => 6);
      utimes(db, "/link", 2_000);
      expect(stat(db, "/target").mtime).toBe(2_000);
      expect(lstat(db, "/link").mtime).toBe(6);
    });
  });

  it("keeps the time through an open write buffer's release", async () => {
    await withDB((db) => {
      writeFileSync(db, "/f", bytes("old"), {}, () => 5);
      openWriteBufferSync(db, "/f");
      writeRangeSync(db, "/f", bytes("new"), 0, {}, () => 6);
      utimes(db, "/f", 3_000);
      releaseWriteBufferSync(db, "/f", () => 7);
      expect(stat(db, "/f").mtime).toBe(3_000);
    });
  });

  it("lets a later write replace the time, as a write after utimes does", async () => {
    await withDB((db) => {
      writeFileSync(db, "/f", bytes("old"), {}, () => 5);
      openWriteBufferSync(db, "/f");
      utimes(db, "/f", 3_000);
      writeRangeSync(db, "/f", bytes("new"), 0, {}, () => 6);
      releaseWriteBufferSync(db, "/f", () => 7);
      expect(stat(db, "/f").mtime).toBe(7);
    });
  });

  it("applies to a pending create when it commits", async () => {
    await withDB((db) => {
      openWriteBufferForCreateSync(db, "/new", {}, () => 5);
      writeRangeSync(db, "/new", bytes("data"), 0, {}, () => 6);
      utimes(db, "/new", 4_000);
      expect(stat(db, "/new").mtime).toBe(4_000);
      releaseWriteBufferSync(db, "/new", () => 7);
      expect(stat(db, "/new").mtime).toBe(4_000);
    });
  });

  it("throws ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => utimes(db, "/missing", 1)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("refuses a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/ro", {}, () => 5);
      writeFileSync(db, "/ro/f", bytes("x"), {}, () => 5);
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES ('/ro', 'r2', 'read-only')");
      invalidateReadOnlyMountCache(db);
      expect(() => utimes(db, "/ro/f", 1)).toThrowError(expect.objectContaining({ code: "EROFS" }));
    });
  });

  it("refuses a read-only mount reached through a symlink", async () => {
    await withDB((db) => {
      mkdir(db, "/ro", {}, () => 5);
      writeFileSync(db, "/ro/f", bytes("x"), {}, () => 5);
      symlink(db, "/ro/f", "/file-link", () => 5);
      symlink(db, "/ro", "/dir-link", () => 5);
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES ('/ro', 'r2', 'read-only')");
      invalidateReadOnlyMountCache(db);
      for (const path of ["/file-link", "/dir-link", "/dir-link/f"]) {
        expect(() => utimes(db, path, 1)).toThrowError(expect.objectContaining({ code: "EROFS" }));
      }
      expect(stat(db, "/ro/f").mtime).toBe(5);
    });
  });
});
