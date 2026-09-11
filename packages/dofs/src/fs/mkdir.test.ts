import { describe, expect, it } from "vitest";

import { ROOT_INODE } from "../schema/index.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { writeFile } from "./writeFile.js";

describe("mkdir", () => {
  it("creates a top-level directory with the default mode", async () => {
    await withDB((db) => {
      mkdir(db, "/a", {}, () => 2000);
      const resolved = resolveInode(db, "/a");
      expect(resolved).toMatchObject({ type: "dir", mode: 0o755, mtime: 2000 });
    });
  });

  it("honors the supplied mode", async () => {
    await withDB((db) => {
      mkdir(db, "/locked", { mode: 0o700 }, () => 0);
      expect(resolveInode(db, "/locked")?.mode).toBe(0o700);
    });
  });

  it("bumps rev and stamps it onto the new node", async () => {
    await withDB((db) => {
      const beforeRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      mkdir(db, "/a", {}, () => 0);
      const afterRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      expect(afterRev).toBe((beforeRev ?? 0) + 1);

      const nodeRev = db.scalar<number>(
        "SELECT n.rev FROM vfs_nodes n JOIN vfs_dirents d ON d.child_inode = n.inode WHERE d.parent_inode = ? AND d.name = ?",
        ROOT_INODE,
        "a",
      );
      expect(nodeRev).toBe(afterRev);
    });
  });

  it("rejects when the parent directory is missing", async () => {
    await withDB((db) => {
      expect(() => mkdir(db, "/no/such/parent", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("rejects when the parent path segment is a file (ENOTDIR)", async () => {
    await withDB((db) => {
      db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
      const inode = db.scalar<number>("SELECT last_insert_rowid()");
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        ROOT_INODE,
        "a",
        inode,
      );
      expect(() => mkdir(db, "/a/b", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
    });
  });

  it("rejects EEXIST when the path already exists as a directory without recursive", async () => {
    await withDB((db) => {
      mkdir(db, "/a", {}, () => 0);
      expect(() => mkdir(db, "/a", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("rejects EEXIST when the path already exists as a file", async () => {
    await withDB((db) => {
      db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
      const inode = db.scalar<number>("SELECT last_insert_rowid()");
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        ROOT_INODE,
        "a",
        inode,
      );
      expect(() => mkdir(db, "/a", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("recursive: creates missing ancestors", async () => {
    await withDB((db) => {
      mkdir(db, "/x/y/z", { recursive: true }, () => 1234);
      expect(resolveInode(db, "/x")?.type).toBe("dir");
      expect(resolveInode(db, "/x/y")?.type).toBe("dir");
      expect(resolveInode(db, "/x/y/z")?.type).toBe("dir");
    });
  });

  it("recursive: is idempotent when the target already exists as a dir", async () => {
    await withDB((db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      expect(() => mkdir(db, "/a/b", { recursive: true }, () => 0)).not.toThrow();
    });
  });

  it("recursive: still rejects EEXIST when the target exists as a file", async () => {
    await withDB((db) => {
      mkdir(db, "/a", {}, () => 0);
      db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
      const inode = db.scalar<number>("SELECT last_insert_rowid()");
      const aInode = resolveInode(db, "/a")?.inode;
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        aInode,
        "b",
        inode,
      );
      expect(() => mkdir(db, "/a/b", { recursive: true }, () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("rejects EEXIST when creating root", async () => {
    await withDB((db) => {
      expect(() => mkdir(db, "/", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("accepts recursive: false for node:fs/promises parity", async () => {
    await withDB((db) => {
      // boolean false should be accepted by the type and behave as default.
      mkdir(db, "/dir", { recursive: false }, () => 0);
      expect(() => mkdir(db, "/dir", { recursive: false }, () => 0)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  describe("symlinked parents", () => {
    it("follows an absolute link in an intermediate segment", async () => {
      await withDB((db) => {
        mkdir(db, "/real", {}, () => 0);
        symlink(db, "/real", "/alias", () => 0);
        mkdir(db, "/alias/new-directory", {}, () => 0);
        expect(resolveInode(db, "/real/new-directory")?.type).toBe("dir");
      });
    });

    it("follows a relative link in an intermediate segment", async () => {
      await withDB((db) => {
        mkdir(db, "/base/real", { recursive: true }, () => 0);
        symlink(db, "real", "/base/alias", () => 0);
        mkdir(db, "/base/alias/child", {}, () => 0);
        expect(resolveInode(db, "/base/real/child")?.type).toBe("dir");
      });
    });

    it("follows a chain of links", async () => {
      await withDB((db) => {
        mkdir(db, "/real", {}, () => 0);
        symlink(db, "/real", "/first", () => 0);
        symlink(db, "/first", "/second", () => 0);
        mkdir(db, "/second/child", {}, () => 0);
        expect(resolveInode(db, "/real/child")?.type).toBe("dir");
      });
    });

    it("creates recursive ancestors under the resolved parent", async () => {
      await withDB((db) => {
        mkdir(db, "/real", {}, () => 0);
        symlink(db, "/real", "/alias", () => 0);
        mkdir(db, "/alias/a/b/c", { recursive: true }, () => 0);
        expect(resolveInode(db, "/real/a/b/c")?.type).toBe("dir");
      });
    });

    it("is idempotent through a link when the target already exists", async () => {
      await withDB((db) => {
        mkdir(db, "/real/child", { recursive: true }, () => 0);
        symlink(db, "/real", "/alias", () => 0);
        expect(() => mkdir(db, "/alias/child", { recursive: true }, () => 0)).not.toThrow();
      });
    });

    it("reports ENOTDIR when a link resolves to a file", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/file", "x", {}, () => 0);
        symlink(db, "/file", "/alias", () => 0);
        expect(() => mkdir(db, "/alias/child", {}, () => 0)).toThrowError(
          expect.objectContaining({ code: "ENOTDIR" }),
        );
      });
    });

    it("reports ENOENT for a dangling parent link", async () => {
      await withDB((db) => {
        symlink(db, "/missing", "/alias", () => 0);
        expect(() => mkdir(db, "/alias/child", {}, () => 0)).toThrowError(
          expect.objectContaining({ code: "ENOENT" }),
        );
      });
    });

    it("reports ENOENT for a dangling parent link under recursive", async () => {
      await withDB((db) => {
        symlink(db, "/missing", "/alias", () => 0);
        expect(() => mkdir(db, "/alias/child", { recursive: true }, () => 0)).toThrowError(
          expect.objectContaining({ code: "ENOENT" }),
        );
      });
    });

    it("reports ELOOP for a link cycle", async () => {
      await withDB((db) => {
        symlink(db, "/b", "/a", () => 0);
        symlink(db, "/a", "/b", () => 0);
        expect(() => mkdir(db, "/a/child", {}, () => 0)).toThrowError(
          expect.objectContaining({ code: "ELOOP" }),
        );
      });
    });

    it("reports ELOOP after more than forty link traversals", async () => {
      await withDB((db) => {
        mkdir(db, "/real", {}, () => 0);
        symlink(db, "/real", "/link0", () => 0);
        for (let i = 1; i <= 41; i++) {
          symlink(db, `/link${i - 1}`, `/link${i}`, () => 0);
        }
        expect(() => mkdir(db, "/link41/child", {}, () => 0)).toThrowError(
          expect.objectContaining({ code: "ELOOP" }),
        );
        expect(() => mkdir(db, "/link39/child", {}, () => 0)).not.toThrow();
      });
    });
  });
});
