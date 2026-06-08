import { describe, expect, it } from "vitest";
import { withDB } from "./fs/with-db.js";
import { SQLiteWorkspaceProvider } from "./provider.js";

// Each provider test gets a fresh DB via withDB, which the workers
// runner aliases to a DO-backed implementation. The provider holds
// no I/O resources of its own, so it's safe to construct inside the
// withDB callback and let the storage handle teardown.
async function withProvider<T>(fn: (p: SQLiteWorkspaceProvider) => T | Promise<T>): Promise<T> {
  return withDB((db) => fn(new SQLiteWorkspaceProvider(db, { now: () => 1000 })));
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

  it("source missing throws ENOENT", async () => {
    await withProvider((p) => {
      expect(() => p.renameSync("/missing", "/dst")).toThrowError(
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

  // TODO: renaming a symlink should move the link itself, not the
  // target. Today renameSync uses resolveInode() with the default
  // followSymlinks: true, so a rename on a symlink actually moves the
  // pointed-at file. Pin this once renameSync grows an
  // lresolveInode-style call (see provider.ts:248).
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
