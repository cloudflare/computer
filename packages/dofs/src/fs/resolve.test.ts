import { describe, expect, it } from "vitest";

import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { withDB } from "./with-db.js";

// Convenience: insert a node row and a dirent under a given parent.
// Returns the new inode. type defaults to 'file' so directory tests are
// explicit.
function addNode(
  db: Database,
  parentInode: number,
  name: string,
  options: { type?: "file" | "dir"; mode?: number; mtime?: number } = {},
): number {
  const type = options.type ?? "file";
  const mode = options.mode ?? (type === "dir" ? 0o755 : 0o644);
  const mtime = options.mtime ?? 0;
  db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES (?, ?, ?, 0)", type, mode, mtime);
  const inode = db.scalar<number>("SELECT last_insert_rowid()");
  if (inode === undefined) {
    throw new Error("failed to allocate inode");
  }
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parentInode,
    name,
    inode,
  );
  return inode;
}

describe("resolveInode", () => {
  it("resolves the root", async () => {
    await withDB(
      (db) => {
        expect(resolveInode(db, "/")).toEqual({
          inode: ROOT_INODE,
          type: "dir",
          mode: 0o755,
          mtime: 0,
          size: 0,
        });
      },
      { now: () => 0 },
    );
  });

  it("resolves a top-level file", async () => {
    await withDB((db) => {
      const inode = addNode(db, ROOT_INODE, "hello.txt", { type: "file", mode: 0o644, mtime: 99 });
      expect(resolveInode(db, "/hello.txt")).toEqual({
        inode,
        type: "file",
        mode: 0o644,
        mtime: 99,
        size: 0,
      });
    });
  });

  it("resolves a nested directory", async () => {
    await withDB((db) => {
      const dir = addNode(db, ROOT_INODE, "a", { type: "dir" });
      const sub = addNode(db, dir, "b", { type: "dir" });
      const leaf = addNode(db, sub, "c.txt", { type: "file", mtime: 7 });
      expect(resolveInode(db, "/a/b/c.txt")).toEqual({
        inode: leaf,
        type: "file",
        mode: 0o644,
        mtime: 7,
        size: 0,
      });
    });
  });

  it("returns null when the final segment is missing", async () => {
    await withDB((db) => {
      addNode(db, ROOT_INODE, "a", { type: "dir" });
      expect(resolveInode(db, "/a/missing")).toBeNull();
    });
  });

  it("returns null when an intermediate segment is missing", async () => {
    await withDB((db) => {
      expect(resolveInode(db, "/no/such/path")).toBeNull();
    });
  });

  it("returns null when an intermediate segment is a file (not a dir)", async () => {
    await withDB((db) => {
      addNode(db, ROOT_INODE, "a", { type: "file" });
      expect(resolveInode(db, "/a/b")).toBeNull();
    });
  });
});
