import { describe, expect, it } from "vitest";
import { withDB } from "./fs/with-db.js";
import { SQLiteWorkspaceProvider } from "./provider.js";
import type { Database } from "./storage.js";
import type { ChangeEntry } from "./sync/changes.js";
import { coalesceChanges } from "./sync/coalesce.js";

// Each provider test gets a fresh DB via withDB, which the workers
// runner aliases to a DO-backed implementation. The provider holds
// no I/O resources of its own, so it's safe to construct inside the
// withDB callback and let the storage handle teardown.
async function withProvider<T>(fn: (p: SQLiteWorkspaceProvider) => T | Promise<T>): Promise<T> {
  return withDB((db) => fn(new SQLiteWorkspaceProvider(db, { now: () => 1000 })));
}

async function withProviderAndDB<T>(
  fn: (p: SQLiteWorkspaceProvider, db: Database) => T | Promise<T>,
): Promise<T> {
  return withDB((db) => fn(new SQLiteWorkspaceProvider(db, { now: () => 1000 }), db));
}

async function drainChanges(db: Database, afterRev: number): Promise<ChangeEntry[]> {
  const out: ChangeEntry[] = [];
  for await (const entry of coalesceChanges(db, afterRev)) out.push(entry);
  return out;
}

function kindPath(entries: ChangeEntry[]): Array<[ChangeEntry["kind"], string]> {
  return entries.map((entry) => [entry.kind, entry.path]).sort((a, b) => a[1].localeCompare(b[1]));
}

describe("SQLiteWorkspaceProvider — capability flags", () => {
  it("reports the supported feature set", async () => {
    await withProvider((p) => {
      expect(p.readonly).toBe(false);
      expect(p.supportsSymlinks).toBe(true);
      expect(p.supportsWatch).toBe(true);
    });
  });
});

describe("SQLiteWorkspaceProvider — implemented methods", () => {
  it("mkdirSync creates a directory", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", { mode: 0o755 });
      expect(p.existsSync("/a")).toBe(true);
    });
  });

  it("statSync returns a VirtualStats-shaped object", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      const s = p.statSync("/a");
      expect(s.isDirectory()).toBe(true);
      expect(s.isFile()).toBe(false);
      expect(s.isSymbolicLink()).toBe(false);
      // 0o40755 — S_IFDIR or permissions. Linux FUSE rejects a
      // stat without the file-type bits, so we always set them.
      expect(s.mode).toBe(0o40755);
      expect(typeof s.ino).toBe("number");
      expect(typeof s.mtimeMs).toBe("number");
      expect(s.mtime).toBeInstanceOf(Date);
    });
  });

  it("lstatSync returns the same shape as statSync today (no symlinks yet)", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(p.lstatSync("/a").isDirectory()).toBe(true);
    });
  });

  it("readdirSync returns names by default and dirent objects with withFileTypes", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      p.mkdirSync("/b", {});
      expect(p.readdirSync("/")).toEqual(["a", "b"]);
      const dirents = p.readdirSync("/", { withFileTypes: true });
      expect(Array.isArray(dirents)).toBe(true);
      expect((dirents as Array<{ name: string; isDirectory(): boolean }>)[0].isDirectory()).toBe(
        true,
      );
    });
  });

  it("unlinkSync removes a file", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.unlinkSync("/a.txt");
      expect(p.existsSync("/a.txt")).toBe(false);
    });
  });

  it("linkSync creates a second path to the same file inode", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.linkSync("/a.txt", "/b.txt");

      const a = p.statSync("/a.txt");
      const b = p.statSync("/b.txt");
      expect(a.ino).toBe(b.ino);
      expect(a.nlink).toBe(2);
      expect(b.nlink).toBe(2);
      expect(p.readFileSync("/b.txt", "utf8")).toBe("hi");
    });
  });

  it("writes through one hardlink are visible through the other", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.linkSync("/a.txt", "/b.txt");
      p.writeFileSync("/b.txt", "bye");

      expect(p.readFileSync("/a.txt", "utf8")).toBe("bye");
      expect(p.statSync("/a.txt").nlink).toBe(2);
      expect(p.statSync("/b.txt").nlink).toBe(2);
    });
  });

  it("unlinkSync removes one hardlink without deleting the inode", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.linkSync("/a.txt", "/b.txt");
      p.unlinkSync("/a.txt");

      expect(p.existsSync("/a.txt")).toBe(false);
      expect(p.readFileSync("/b.txt", "utf8")).toBe("hi");
      expect(p.statSync("/b.txt").nlink).toBe(1);
    });
  });

  it("renameSync from one hardlink onto another removes only the source name", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.linkSync("/a.txt", "/b.txt");
      p.renameSync("/a.txt", "/b.txt");

      expect(p.existsSync("/a.txt")).toBe(false);
      expect(p.readFileSync("/b.txt", "utf8")).toBe("hi");
      expect(p.statSync("/b.txt").nlink).toBe(1);
    });
  });

  it("linkSync rejects invalid links", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hi");
      p.mkdirSync("/dir", {});

      expect(() => p.linkSync("/missing", "/missing-link")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(() => p.linkSync("/a.txt", "/a.txt")).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
      expect(() => p.linkSync("/dir", "/dir-link")).toThrowError(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(() => p.linkSync("/a.txt", "/missing-parent/b.txt")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("unlinkSync removes a symlink without deleting its target", async () => {
    await withProvider((p) => {
      p.writeFileSync("/target", "content");
      p.symlinkSync("/target", "/link");

      p.unlinkSync("/link");

      expect(p.existsSync("/link")).toBe(false);
      expect(p.readFileSync("/target", "utf8")).toBe("content");
    });
  });

  it("rmdirSync removes an empty directory", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      p.rmdirSync("/a");
      expect(p.existsSync("/a")).toBe(false);
    });
  });

  it("renameSync moves an entry", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "x");
      p.renameSync("/a", "/b");
      expect(p.existsSync("/a")).toBe(false);
      expect(p.existsSync("/b")).toBe(true);
    });
  });

  it("writeFileSync + readFileSync round-trip a string", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hello workspace");
      expect(p.readFileSync("/a.txt", "utf8")).toBe("hello workspace");
    });
  });

  it("writeFileSync + readFileSync round-trip bytes", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a.bin", Buffer.from([1, 2, 3]));
      const back = p.readFileSync("/a.bin");
      expect(back).toBeInstanceOf(Buffer);
      expect(Array.from(back as Buffer)).toEqual([1, 2, 3]);
    });
  });

  it("existsSync returns true / false correctly", async () => {
    await withProvider((p) => {
      expect(p.existsSync("/missing")).toBe(false);
      p.mkdirSync("/d", {});
      expect(p.existsSync("/d")).toBe(true);
    });
  });

  it("realpathSync returns the canonical path", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(p.realpathSync("/a/./../a")).toBe("/a");
    });
  });

  it("accessSync resolves for existing paths and throws ENOENT for missing", async () => {
    await withProvider((p) => {
      p.mkdirSync("/a", {});
      expect(() => p.accessSync("/a")).not.toThrow();
      expect(() => p.accessSync("/missing")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });
});

describe("SQLiteWorkspaceProvider — renameSync overwrite matrix", () => {
  it("records rename as an old-path delete and new-path live entry", async () => {
    await withProviderAndDB(async (p, db) => {
      p.writeFileSync("/src", "new");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/src", "/dst");

      const entries = await drainChanges(db, cursor);
      expect(kindPath(entries)).toEqual([
        ["file", "/dst"],
        ["delete", "/src"],
      ]);
    });
  });

  it("records directory rename for the whole moved subtree", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/src", {});
      p.writeFileSync("/src/a.txt", "a");
      p.mkdirSync("/src/sub", {});
      p.writeFileSync("/src/sub/b.txt", "b");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/src", "/dst");

      const entries = await drainChanges(db, cursor);
      expect(kindPath(entries)).toEqual([
        ["dir", "/dst"],
        ["file", "/dst/a.txt"],
        ["dir", "/dst/sub"],
        ["file", "/dst/sub/b.txt"],
        ["delete", "/src"],
        ["delete", "/src/a.txt"],
        ["delete", "/src/sub"],
        ["delete", "/src/sub/b.txt"],
      ]);
    });
  });

  it("records rename tombstones at the resolved old file path", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/real", {});
      p.writeFileSync("/real/file.txt", "x");
      p.symlinkSync("/real", "/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/link/file.txt", "/dst.txt");

      const entries = await drainChanges(db, cursor);
      expect(kindPath(entries)).toEqual([
        ["file", "/dst.txt"],
        ["delete", "/real/file.txt"],
      ]);
    });
  });

  it("records directory rename tombstones at the resolved old subtree paths", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/real", {});
      p.mkdirSync("/real/dir", {});
      p.writeFileSync("/real/dir/a.txt", "a");
      p.mkdirSync("/real/dir/sub", {});
      p.writeFileSync("/real/dir/sub/b.txt", "b");
      p.symlinkSync("/real", "/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/link/dir", "/dst");

      const entries = await drainChanges(db, cursor);
      expect(kindPath(entries)).toEqual([
        ["dir", "/dst"],
        ["file", "/dst/a.txt"],
        ["dir", "/dst/sub"],
        ["file", "/dst/sub/b.txt"],
        ["delete", "/real/dir"],
        ["delete", "/real/dir/a.txt"],
        ["delete", "/real/dir/sub"],
        ["delete", "/real/dir/sub/b.txt"],
      ]);
    });
  });

  it("subtree rename writes one tombstone per edge and one rev stamp per inode", async () => {
    await withProviderAndDB(async (p, db) => {
      // A nested subtree with a hardlink inside it: the file inode is
      // reachable by two names, so both edges must be tombstoned while
      // the single inode is stamped once.
      p.mkdirSync("/src", {});
      p.writeFileSync("/src/a.txt", "a");
      p.mkdirSync("/src/sub", {});
      p.writeFileSync("/src/sub/b.txt", "b");
      p.linkSync("/src/a.txt", "/src/sub/a2.txt");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/src", "/dst");

      // Every edge of the moved subtree, tombstoned at its old path and
      // sharing the rename's rev.
      const tombstones = db.all<{ rev: number; path: string; op: string }>(
        "SELECT rev, path, op FROM vfs_changes WHERE rev > ? ORDER BY path",
        cursor,
      );
      const rev = tombstones[0]?.rev;
      expect(tombstones).toEqual([
        { rev, path: "/src", op: "delete" },
        { rev, path: "/src/a.txt", op: "delete" },
        { rev, path: "/src/sub", op: "delete" },
        { rev, path: "/src/sub/a2.txt", op: "delete" },
        { rev, path: "/src/sub/b.txt", op: "delete" },
      ]);

      // The shared rev lands on exactly the four subtree inodes (the
      // hardlinked file counted once) and on nothing else.
      const stamped = db
        .all<{ inode: number }>("SELECT inode FROM vfs_nodes WHERE rev = ? ORDER BY inode", rev)
        .map((r) => r.inode);
      const expected = [
        p.statSync("/dst").ino,
        p.statSync("/dst/a.txt").ino,
        p.statSync("/dst/sub").ino,
        p.statSync("/dst/sub/b.txt").ino,
      ].sort((a, b) => a - b);
      expect(stamped).toEqual(expected);
    });
  });

  it("same-inode rename through a symlinked file path is a no-op", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/real", {});
      p.writeFileSync("/real/file.txt", "x");
      p.symlinkSync("/real", "/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/real/file.txt", "/link/file.txt");

      expect(p.readFileSync("/real/file.txt", "utf8")).toBe("x");
      expect(p.readFileSync("/link/file.txt", "utf8")).toBe("x");
      expect(await drainChanges(db, cursor)).toEqual([]);
    });
  });

  it("same-inode rename through a symlinked directory path is a no-op", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/real", {});
      p.mkdirSync("/real/dir", {});
      p.writeFileSync("/real/dir/a.txt", "a");
      p.symlinkSync("/real", "/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/real/dir", "/link/dir");

      expect(p.readFileSync("/real/dir/a.txt", "utf8")).toBe("a");
      expect(p.readFileSync("/link/dir/a.txt", "utf8")).toBe("a");
      expect(await drainChanges(db, cursor)).toEqual([]);
    });
  });

  it("file → existing file overwrites atomically", async () => {
    await withProvider((p) => {
      p.writeFileSync("/src", "new");
      p.writeFileSync("/dst", "old");
      p.renameSync("/src", "/dst");
      expect(p.existsSync("/src")).toBe(false);
      expect(p.readFileSync("/dst", "utf8")).toBe("new");
    });
  });

  it("dir → existing non-empty dir throws ENOTEMPTY", async () => {
    await withProvider((p) => {
      p.mkdirSync("/src", {});
      p.mkdirSync("/dst", {});
      p.writeFileSync("/dst/inside", "x");
      expect(() => p.renameSync("/src", "/dst")).toThrowError(
        expect.objectContaining({ code: "ENOTEMPTY" }),
      );
      // Both directories survive the failed rename.
      expect(p.existsSync("/src")).toBe(true);
      expect(p.existsSync("/dst/inside")).toBe(true);
    });
  });

  it("dir → existing empty dir succeeds", async () => {
    await withProvider((p) => {
      p.mkdirSync("/src", {});
      p.writeFileSync("/src/inside", "x");
      p.mkdirSync("/dst", {});
      p.renameSync("/src", "/dst");
      expect(p.existsSync("/src")).toBe(false);
      expect(p.readFileSync("/dst/inside", "utf8")).toBe("x");
    });
  });

  it.each([
    {
      name: "file → existing symlink",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/target", "x");
        p.writeFileSync("/src", "new");
        p.symlinkSync("/target", "/dst");
      },
      assertRenamed(p: SQLiteWorkspaceProvider) {
        expect(p.existsSync("/src")).toBe(false);
        expect(p.lstatSync("/dst").isFile()).toBe(true);
        expect(p.readFileSync("/dst", "utf8")).toBe("new");
        expect(p.readFileSync("/target", "utf8")).toBe("x");
      },
    },
    {
      name: "symlink → existing file",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/target", "x");
        p.symlinkSync("/target", "/src");
        p.writeFileSync("/dst", "old");
      },
      assertRenamed(p: SQLiteWorkspaceProvider) {
        expect(p.existsSync("/src")).toBe(false);
        expect(p.lstatSync("/dst").isSymbolicLink()).toBe(true);
        expect(p.readlinkSync("/dst")).toBe("/target");
      },
    },
    {
      name: "symlink → existing symlink",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/target", "x");
        p.writeFileSync("/other", "y");
        p.symlinkSync("/target", "/src");
        p.symlinkSync("/other", "/dst");
      },
      assertRenamed(p: SQLiteWorkspaceProvider) {
        expect(p.existsSync("/src")).toBe(false);
        expect(p.lstatSync("/dst").isSymbolicLink()).toBe(true);
        expect(p.readlinkSync("/dst")).toBe("/target");
      },
    },
  ])("$name overwrites atomically", async ({ setup, assertRenamed }) => {
    await withProvider((p) => {
      setup(p);
      p.renameSync("/src", "/dst");
      assertRenamed(p);
    });
  });

  it.each([
    {
      name: "file → existing empty dir",
      code: "EISDIR",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/src", "new");
        p.mkdirSync("/dst", {});
      },
      assertUnchanged(p: SQLiteWorkspaceProvider) {
        expect(p.readFileSync("/src", "utf8")).toBe("new");
        expect(p.statSync("/dst").isDirectory()).toBe(true);
      },
    },
    {
      name: "symlink → existing empty dir",
      code: "EISDIR",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/target", "x");
        p.symlinkSync("/target", "/src");
        p.mkdirSync("/dst", {});
      },
      assertUnchanged(p: SQLiteWorkspaceProvider) {
        expect(p.readlinkSync("/src")).toBe("/target");
        expect(p.statSync("/dst").isDirectory()).toBe(true);
      },
    },
    {
      name: "dir → existing file",
      code: "ENOTDIR",
      setup(p: SQLiteWorkspaceProvider) {
        p.mkdirSync("/src", {});
        p.writeFileSync("/dst", "old");
      },
      assertUnchanged(p: SQLiteWorkspaceProvider) {
        expect(p.statSync("/src").isDirectory()).toBe(true);
        expect(p.readFileSync("/dst", "utf8")).toBe("old");
      },
    },
    {
      name: "dir → existing symlink",
      code: "ENOTDIR",
      setup(p: SQLiteWorkspaceProvider) {
        p.writeFileSync("/target", "x");
        p.mkdirSync("/src", {});
        p.symlinkSync("/target", "/dst");
      },
      assertUnchanged(p: SQLiteWorkspaceProvider) {
        expect(p.statSync("/src").isDirectory()).toBe(true);
        expect(p.readlinkSync("/dst")).toBe("/target");
      },
    },
  ])("$name rejects without recording sync changes", async ({ code, setup, assertUnchanged }) => {
    await withProviderAndDB(async (p, db) => {
      setup(p);
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => p.renameSync("/src", "/dst")).toThrowError(expect.objectContaining({ code }));

      assertUnchanged(p);
      expect(await drainChanges(db, cursor)).toEqual([]);
    });
  });

  it("source missing throws ENOENT", async () => {
    await withProvider((p) => {
      expect(() => p.renameSync("/missing", "/dst")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("same-path rename validates the source before no-op", async () => {
    await withProvider((p) => {
      expect(() => p.renameSync("/missing", "/missing")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("same-path rename of an existing file is a no-op", async () => {
    await withProviderAndDB(async (p, db) => {
      p.writeFileSync("/src", "x");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/src", "/src");

      expect(p.readFileSync("/src", "utf8")).toBe("x");
      expect(await drainChanges(db, cursor)).toEqual([]);
    });
  });

  it("rename of a file into itself as a parent does not report directory self-move", async () => {
    await withProvider((p) => {
      p.writeFileSync("/file", "x");
      expect(() => p.renameSync("/file", "/file/child")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("rename onto root throws EINVAL", async () => {
    await withProvider((p) => {
      p.writeFileSync("/src", "x");
      expect(() => p.renameSync("/src", "/")).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    });
  });

  it("rename into a missing parent throws ENOENT", async () => {
    await withProvider((p) => {
      p.writeFileSync("/src", "x");
      expect(() => p.renameSync("/src", "/no-such-dir/dst")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("rename of a symlink moves the link itself", async () => {
    await withProvider((p) => {
      p.writeFileSync("/target", "x");
      p.symlinkSync("/target", "/link");
      p.renameSync("/link", "/moved");
      expect(p.existsSync("/target")).toBe(true);
      expect(p.readlinkSync("/moved")).toBe("/target");
      expect(p.existsSync("/link")).toBe(false);
    });
  });

  it("rename of a directory into its own subtree throws EINVAL", async () => {
    await withProvider((p) => {
      p.mkdirSync("/src", {});
      p.mkdirSync("/src/sub", {});
      expect(() => p.renameSync("/src", "/src/sub/dst")).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    });
  });

  it("rename of a directory through a symlink into its own subtree throws EINVAL", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/src", {});
      p.mkdirSync("/src/sub", {});
      p.symlinkSync("/src/sub", "/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => p.renameSync("/src", "/link/dst")).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );

      expect(p.statSync("/src/sub").isDirectory()).toBe(true);
      expect(p.readlinkSync("/link")).toBe("/src/sub");
      expect(await drainChanges(db, cursor)).toEqual([]);
    });
  });

  it("rename of a directory through a symlink out of its subtree succeeds", async () => {
    await withProviderAndDB(async (p, db) => {
      p.mkdirSync("/src", {});
      p.mkdirSync("/other", {});
      // /src/link points outside the source subtree, so the destination
      // /src/link/dst resolves to /other/dst even though the literal path
      // is lexically under /src. The self-move guard is inode-based and
      // must allow this move rather than reject it on a textual prefix.
      p.symlinkSync("/other", "/src/link");
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      p.renameSync("/src", "/src/link/dst");

      expect(p.statSync("/other/dst").isDirectory()).toBe(true);
      expect(p.existsSync("/src")).toBe(false);
      expect(await drainChanges(db, cursor)).not.toEqual([]);
    });
  });
});

describe("SQLiteWorkspaceProvider — unimplemented surface (stubs)", () => {
  it.each([
    ["appendFileSync", (p: SQLiteWorkspaceProvider) => p.appendFileSync("/x", "y")],
    ["copyFileSync", (p: SQLiteWorkspaceProvider) => p.copyFileSync("/x", "/y")],
    ["internalModuleStat", (p: SQLiteWorkspaceProvider) => p.internalModuleStat("/x")],

    ["watchFile", (p: SQLiteWorkspaceProvider) => p.watchFile("/x")],
  ])("%s throws ENOSYS", async (_name, call) => {
    await withProvider((p) => {
      expect(() => call(p)).toThrowError(expect.objectContaining({ code: "ENOSYS" }));
    });
  });
});

describe("SQLiteWorkspaceProvider — pending-create flush on rename/link/unlink", () => {
  it("linkSync commits a pending-create source before adding the second dirent", async () => {
    await withProvider((p) => {
      p.openWriteBufferForCreateSync("/src.txt", { mode: 0o644 });
      p.writeRangeSync("/src.txt", Buffer.from("linked"), 0);
      p.linkSync("/src.txt", "/dst.txt");

      expect((p.readFileSync("/dst.txt") as Buffer).toString()).toBe("linked");
      expect(p.statSync("/src.txt").ino).toBe(p.statSync("/dst.txt").ino);
      expect(p.statSync("/src.txt").nlink).toBe(2);

      p.releaseWriteBufferSync("/src.txt");
      expect((p.readFileSync("/src.txt") as Buffer).toString()).toBe("linked");
    });
  });

  it("renameSync commits a pending-create source before moving the dirent", async () => {
    await withProvider((p) => {
      p.openWriteBufferForCreateSync("/from.txt", { mode: 0o644 });
      p.writeRangeSync("/from.txt", Buffer.from("moved"), 0);
      p.renameSync("/from.txt", "/to.txt");

      expect((p.readFileSync("/to.txt") as Buffer).toString()).toBe("moved");
      expect(p.existsSync("/from.txt")).toBe(false);
    });
  });

  it("renameSync commits pending descendants before moving a directory", async () => {
    await withProvider((p) => {
      p.mkdirSync("/old");
      p.openWriteBufferForCreateSync("/old/pending.txt", { mode: 0o644 });
      p.writeRangeSync("/old/pending.txt", Buffer.from("pending"), 0);

      p.renameSync("/old", "/new");

      expect((p.readFileSync("/new/pending.txt") as Buffer).toString()).toBe("pending");
      expect(() =>
        p.openWriteBufferForCreateSync("/new/pending.txt", { mode: 0o644 }),
      ).toThrowError(expect.objectContaining({ code: "EEXIST" }));
      expect(() => p.releaseWriteBufferSync("/new/pending.txt")).not.toThrow();
    });
  });

  it("renameSync commits lexical pending descendants reached through symlinks", async () => {
    await withProvider((p) => {
      p.mkdirSync("/src");
      p.mkdirSync("/outside");
      p.symlinkSync("/outside", "/src/link");
      p.openWriteBufferForCreateSync("/src/link/pending.txt", { mode: 0o644 });
      p.writeRangeSync("/src/link/pending.txt", Buffer.from("pending"), 0);

      p.renameSync("/src", "/new");

      expect((p.readFileSync("/new/link/pending.txt") as Buffer).toString()).toBe("pending");
      expect(() => p.releaseWriteBufferSync("/new/link/pending.txt")).not.toThrow();
    });
  });

  it("rmdirSync preserves pending descendants", async () => {
    await withProvider((p) => {
      p.mkdirSync("/dir");
      p.openWriteBufferForCreateSync("/dir/pending.txt", { mode: 0o644 });
      p.writeRangeSync("/dir/pending.txt", Buffer.from("pending"), 0);

      expect(() => p.rmdirSync("/dir")).toThrowError(
        expect.objectContaining({ code: "ENOTEMPTY" }),
      );
      expect((p.readFileSync("/dir/pending.txt") as Buffer).toString()).toBe("pending");
      expect(() => p.releaseWriteBufferSync("/dir/pending.txt")).not.toThrow();
    });
  });

  it("unlinkSync commits then removes a pending-create file", async () => {
    await withProvider((p) => {
      p.openWriteBufferForCreateSync("/gone.txt", { mode: 0o644 });
      p.writeRangeSync("/gone.txt", Buffer.from("bye"), 0);
      p.unlinkSync("/gone.txt");
      expect(p.existsSync("/gone.txt")).toBe(false);
    });
  });

  it("linkSync flushes a pending-create destination before colliding", async () => {
    // Pending /dst is committed before link's existence check
    // runs, so the user sees a normal EEXIST against a real inode
    // rather than silently losing the pending bytes when the later
    // release would have tripped its own EEXIST against the link's
    // dirent.
    await withProvider((p) => {
      p.writeFileSync("/src.txt", "src bytes");
      p.openWriteBufferForCreateSync("/dst.txt", { mode: 0o644 });
      p.writeRangeSync("/dst.txt", Buffer.from("pending dst"), 0);

      expect(() => p.linkSync("/src.txt", "/dst.txt")).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );

      // /dst.txt now exists with the previously-pending bytes; the
      // release-after-collision finds the inode it expects and is a
      // no-op rather than a data loss.
      expect((p.readFileSync("/dst.txt") as Buffer).toString()).toBe("pending dst");
      expect(() => p.releaseWriteBufferSync("/dst.txt")).not.toThrow();
      expect((p.readFileSync("/dst.txt") as Buffer).toString()).toBe("pending dst");
    });
  });

  it("renameSync overwrite evicts the displaced destination's buffer", async () => {
    // Open a buffer over an existing /dst, mutate it, then overwrite
    // /dst via rename. The buffer's inode is gone from SQL after
    // rename; release must not commit chunks against the dead row
    // and must not leave a dangling cache entry.
    await withProvider((p) => {
      p.writeFileSync("/src.txt", "src bytes");
      p.writeFileSync("/dst.txt", "dst bytes");
      const dstInodeBefore = p.statSync("/dst.txt").ino;
      p.openWriteBufferSync("/dst.txt");
      p.writeRangeSync("/dst.txt", Buffer.from("dirty"), 0);

      p.renameSync("/src.txt", "/dst.txt");

      // The path now resolves to the renamed source's inode, not
      // the displaced one. Release is a no-op on the now-gone
      // displaced inode; the renamed file's bytes are unchanged.
      expect(p.statSync("/dst.txt").ino).not.toBe(dstInodeBefore);
      expect((p.readFileSync("/dst.txt") as Buffer).toString()).toBe("src bytes");
      expect(() => p.releaseWriteBufferSync("/dst.txt")).not.toThrow();
      expect((p.readFileSync("/dst.txt") as Buffer).toString()).toBe("src bytes");
    });
  });

  it("unlinkSync drops the inode-keyed buffer when the last link disappears", async () => {
    const { getWriteBuffer } = await import("./fs/writeBuffer.js");
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "hello");
      const inode = p.statSync("/a.txt").ino;
      p.openWriteBufferSync("/a.txt");
      p.writeRangeSync("/a.txt", Buffer.from("WORLD"), 0);
      // Buffer is staged in the inode-keyed cache.
      expect(getWriteBuffer(p.db, inode)).toBeDefined();
      p.unlinkSync("/a.txt");
      // unlink removed the last link, so the inode row is gone and
      // the buffer must not be cached against the dead inode.
      expect(p.existsSync("/a.txt")).toBe(false);
      expect(getWriteBuffer(p.db, inode)).toBeUndefined();
    });
  });

  it("unlinkSync keeps the buffer alive when a hardlink remains", async () => {
    const { getWriteBuffer } = await import("./fs/writeBuffer.js");
    await withProvider((p) => {
      p.writeFileSync("/a.txt", "shared");
      p.linkSync("/a.txt", "/b.txt");
      const inode = p.statSync("/a.txt").ino;
      p.openWriteBufferSync("/a.txt");
      p.writeRangeSync("/a.txt", Buffer.from("UPDATED"), 0);
      p.unlinkSync("/a.txt");
      // /b.txt still references the inode; the buffer survives in
      // the inode-keyed cache and a release through the remaining
      // name commits the staged bytes.
      expect(p.existsSync("/b.txt")).toBe(true);
      expect(getWriteBuffer(p.db, inode)).toBeDefined();
      p.releaseWriteBufferSync("/b.txt");
      expect((p.readFileSync("/b.txt") as Buffer).toString()).toBe("UPDATED");
    });
  });
});

describe("SQLiteWorkspaceProvider — cached vfs_nodes.size", () => {
  function readSize(p: SQLiteWorkspaceProvider, name: string): number | undefined {
    return p.db.one<{ size: number }>(
      "SELECT size FROM vfs_nodes WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE name = ?)",
      name,
    )?.size;
  }

  it("writeFileSync stamps size on first write and on overwrite", async () => {
    await withProvider((p) => {
      p.writeFileSync("/sized.bin", Buffer.alloc(123, 0x41));
      expect(p.statSync("/sized.bin").size).toBe(123);
      expect(readSize(p, "sized.bin")).toBe(123);

      p.writeFileSync("/sized.bin", Buffer.alloc(7, 0x42));
      expect(p.statSync("/sized.bin").size).toBe(7);
      expect(readSize(p, "sized.bin")).toBe(7);
    });
  });

  it("writeRangeSync extends the cached size on growth", async () => {
    await withProvider((p) => {
      p.createFileSync("/range.bin", { mode: 0o644 });
      p.writeRangeSync("/range.bin", Buffer.from("hello"), 0);
      expect(readSize(p, "range.bin")).toBe(5);
      p.writeRangeSync("/range.bin", Buffer.from("!!"), 10);
      expect(p.statSync("/range.bin").size).toBe(12);
      expect(readSize(p, "range.bin")).toBe(12);
    });
  });

  it("truncateFileSync updates the cached size on grow and shrink", async () => {
    await withProvider((p) => {
      p.writeFileSync("/trunc.bin", Buffer.alloc(100, 0x55));
      expect(readSize(p, "trunc.bin")).toBe(100);

      p.truncateFileSync("/trunc.bin", 250);
      expect(p.statSync("/trunc.bin").size).toBe(250);
      expect(readSize(p, "trunc.bin")).toBe(250);

      p.truncateFileSync("/trunc.bin", 0);
      expect(p.statSync("/trunc.bin").size).toBe(0);
      expect(readSize(p, "trunc.bin")).toBe(0);
    });
  });

  it("buffered release stamps the cached size of the committed bytes", async () => {
    await withProvider((p) => {
      p.openWriteBufferForCreateSync("/buffered.bin", { mode: 0o644 });
      p.writeRangeSync("/buffered.bin", Buffer.from("buffered-write"), 0);
      expect(readSize(p, "buffered.bin")).toBeUndefined();
      p.releaseWriteBufferSync("/buffered.bin");
      expect(p.statSync("/buffered.bin").size).toBe(14);
      expect(readSize(p, "buffered.bin")).toBe(14);
    });
  });

  it("async writeFile stamps size from the buffered bytes", async () => {
    await withProvider(async (p) => {
      const payload = Buffer.from("async payload");
      await p.writeFile("/streamed.bin", payload);
      expect(p.statSync("/streamed.bin").size).toBe(payload.byteLength);
      expect(readSize(p, "streamed.bin")).toBe(payload.byteLength);
    });
  });
});
