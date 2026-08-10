import { describe, expect, it } from "vitest";

import { mkdir } from "./mkdir.js";
import { invalidateReadOnlyMountCache } from "./mount-guard.js";
import { readFile } from "./readFile.js";
import { readlink } from "./readlink.js";
import { resolveInode } from "./resolve.js";
import { stat } from "./stat.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { writeFile } from "./writeFile.js";

describe("symlink", () => {
  it("creates a symlink node with the requested target", async () => {
    await withDB((db) => {
      symlink(db, "/target", "/link", () => 5000);
      expect(readlink(db, "/link")).toBe("/target");
    });
  });

  it("rejects EEXIST when the path already exists", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a", "x", {}, () => 0);
      expect(() => symlink(db, "/wherever", "/a", () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("rejects ENOENT when the parent directory is missing", async () => {
    await withDB((db) => {
      expect(() => symlink(db, "/t", "/no/such/parent/link", () => 0)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("bumps rev and records mtime", async () => {
    await withDB((db) => {
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      symlink(db, "/t", "/link", () => 4242);
      const after = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      expect(after).toBe(before + 1);
      const row = db.one<{ mtime: number; rev: number; link_target: string }>(
        "SELECT n.mtime, n.rev, n.link_target FROM vfs_nodes n JOIN vfs_dirents d ON d.child_inode = n.inode WHERE d.name = ?",
        "link",
      );
      expect(row?.mtime).toBe(4242);
      expect(row?.rev).toBe(after);
      expect(row?.link_target).toBe("/t");
    });
  });

  it("rejects EROFS when the link path overlaps a read-only mount root", async () => {
    // Same guard that writeFile and mkdir consult — a symlink that
    // lands inside a read-only mount is a write that the indexer
    // must reject before the node table sees it.
    await withDB((db) => {
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES ('/mnt', 'r2', 'read-only')");
      invalidateReadOnlyMountCache(db);
      expect(() => symlink(db, "/elsewhere", "/mnt/link", () => 0)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
    });
  });

  it("creates a symlink inside a nested directory", async () => {
    await withDB((db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      symlink(db, "/t", "/a/b/link", () => 0);
      expect(readlink(db, "/a/b/link")).toBe("/t");
    });
  });
});

describe("readlink", () => {
  it("returns the stored target", async () => {
    await withDB((db) => {
      symlink(db, "/some/target", "/link", () => 0);
      expect(readlink(db, "/link")).toBe("/some/target");
    });
  });

  it("throws ENOENT when the path does not exist", async () => {
    await withDB((db) => {
      expect(() => readlink(db, "/missing")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("throws EINVAL when the path is not a symlink", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/file", "x", {}, () => 0);
      expect(() => readlink(db, "/file")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    });
  });
});

describe("resolveInode + symlinks", () => {
  it("resolveInode follows symlinks by default", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "content", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);
      const node = resolveInode(db, "/link");
      // The target is a file, so following lands on the file node.
      expect(node?.type).toBe("file");
    });
  });

  it("resolveInode with followSymlinks=false returns the link itself", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "content", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);
      const node = resolveInode(db, "/link", { followSymlinks: false });
      expect(node?.type).toBe("symlink");
    });
  });

  it("follows a chain of symlinks", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "content", {}, () => 0);
      symlink(db, "/target", "/a", () => 0);
      symlink(db, "/a", "/b", () => 0);
      symlink(db, "/b", "/c", () => 0);
      expect(resolveInode(db, "/c")?.type).toBe("file");
    });
  });

  it("returns null on a dangling symlink when following", async () => {
    await withDB((db) => {
      symlink(db, "/no/such/target", "/dangling", () => 0);
      expect(resolveInode(db, "/dangling")).toBeNull();
    });
  });

  it("returns the symlink node on a dangling symlink with followSymlinks=false", async () => {
    await withDB((db) => {
      symlink(db, "/no/such/target", "/dangling", () => 0);
      const node = resolveInode(db, "/dangling", { followSymlinks: false });
      expect(node?.type).toBe("symlink");
    });
  });

  it("resolves a bare relative target from the symlink parent", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dir", {}, () => 0);
      await writeFile(db, "/dir/target", "hello", {}, () => 0);
      symlink(db, "target", "/dir/link", () => 0);

      expect(resolveInode(db, "/dir/link")?.inode).toBe(resolveInode(db, "/dir/target")?.inode);
      await expect(readFile(db, "/dir/link", "utf8")).resolves.toBe("hello");
    });
  });

  it("resolves dot and parent segments in relative symlink targets", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dir/sub", { recursive: true }, () => 0);
      await writeFile(db, "/dir/target", "hello", {}, () => 0);
      symlink(db, "./target", "/dir/dot-link", () => 0);
      symlink(db, "../target", "/dir/sub/parent-link", () => 0);

      expect(resolveInode(db, "/dir/dot-link")?.inode).toBe(resolveInode(db, "/dir/target")?.inode);
      expect(resolveInode(db, "/dir/sub/parent-link")?.inode).toBe(
        resolveInode(db, "/dir/target")?.inode,
      );
    });
  });

  it("clamps leading parent segments in relative symlink targets at the root", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "hello", {}, () => 0);
      symlink(db, "../../target", "/link", () => 0);

      expect(resolveInode(db, "/link")?.inode).toBe(resolveInode(db, "/target")?.inode);
    });
  });

  it("resolves remaining path segments after a relative symlink", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dir/real", { recursive: true }, () => 0);
      await writeFile(db, "/dir/real/file.txt", "hello", {}, () => 0);
      symlink(db, "real", "/dir/link", () => 0);

      expect(resolveInode(db, "/dir/link/file.txt")?.inode).toBe(
        resolveInode(db, "/dir/real/file.txt")?.inode,
      );
    });
  });

  it("reports ENOENT for a dangling relative symlink target", async () => {
    await withDB((db) => {
      symlink(db, "missing", "/dangling", () => 0);

      expect(() => stat(db, "/dangling")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });
  });

  it("throws ELOOP on a cycle", async () => {
    await withDB((db) => {
      symlink(db, "/b", "/a", () => 0);
      symlink(db, "/a", "/b", () => 0);
      expect(() => resolveInode(db, "/a")).toThrowError(expect.objectContaining({ code: "ELOOP" }));
    });
  });
});
