import { describe, expect, it } from "vitest";

import { chmod } from "./chmod";
import { mkdir } from "./mkdir";
import { invalidateReadOnlyMountCache } from "./mount-guard";
import { resolveInode } from "./resolve";
import { symlink } from "./symlink";
import { withDB } from "./with-db";
import {
  openWriteBufferSync,
  releaseWriteBufferSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("chmod", () => {
  it("updates the mode on a regular file", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", utf8("hi"), {}, () => 1000);
      chmod(db, "/a.txt", 0o600, () => 2000);
      expect(resolveInode(db, "/a.txt")?.mode).toBe(0o600);
    });
  });

  it("updates the mode on a directory", async () => {
    await withDB((db) => {
      mkdir(db, "/d", { mode: 0o755 }, () => 1000);
      chmod(db, "/d", 0o700, () => 2000);
      expect(resolveInode(db, "/d")?.mode).toBe(0o700);
    });
  });

  it("masks the supplied mode to twelve bits", async () => {
    // POSIX chmod truncates anything above 07777. Mirror that here
    // so callers can hand us a Node-style stat.mode (which carries
    // file-type bits in the upper byte) without corrupting the
    // stored permissions.
    await withDB((db) => {
      writeFileSync(db, "/a", utf8("hi"), {}, () => 0);
      chmod(db, "/a", 0o100644, () => 0);
      expect(resolveInode(db, "/a")?.mode).toBe(0o644);
    });
  });

  it("bumps rev and stamps it onto the node", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a", utf8("hi"), {}, () => 0);
      const beforeRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      chmod(db, "/a", 0o600, () => 0);
      const afterRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      expect(afterRev).toBe((beforeRev ?? 0) + 1);
      const nodeRev = db.scalar<number>(
        "SELECT n.rev FROM vfs_nodes n JOIN vfs_dirents d ON d.child_inode = n.inode WHERE name = ?",
        "a",
      );
      expect(nodeRev).toBe(afterRev);
    });
  });

  it("updates mtime to now()", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a", utf8("hi"), {}, () => 1000);
      chmod(db, "/a", 0o600, () => 5000);
      expect(resolveInode(db, "/a")?.mtime).toBe(5000);
    });
  });

  it("follows symlinks by default — POSIX chmod semantics", async () => {
    // chmod("/link") changes the mode of the target, not the link.
    // POSIX symlinks carry mode 0o777 and chmod against the link
    // itself is a no-op on most kernels. We mirror that.
    await withDB((db) => {
      writeFileSync(db, "/target", utf8("hi"), {}, () => 0);
      symlink(db, "/target", "/link", () => 0);
      chmod(db, "/link", 0o600, () => 0);
      expect(resolveInode(db, "/target")?.mode).toBe(0o600);
      // The symlink node itself stays at 0o777.
      expect(resolveInode(db, "/link", { followSymlinks: false })?.mode).toBe(0o777);
    });
  });

  it("rejects ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => chmod(db, "/missing", 0o600, () => 0)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("rejects EROFS when the path overlaps a read-only mount root", async () => {
    await withDB((db) => {
      // Stage the read-only mount through the same SQL the indexer
      // uses, then materialise a directory under it so chmod has
      // something to land on. invalidateReadOnlyMountCache mirrors
      // what the indexer does after writing _vfs_mounts.
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES ('/mnt', 'r2', 'read-only')");
      invalidateReadOnlyMountCache(db);
      // Directly stage a directory under the mount root via SQL
      // since mkdir() would itself reject under the read-only
      // guard.
      db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('dir', 493, 0, 0)");
      const inode = db.scalar<number>("SELECT last_insert_rowid()");
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (1, 'mnt', ?)",
        inode,
      );
      expect(() => chmod(db, "/mnt", 0o755, () => 0)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
    });
  });

  it("survives an open write buffer's release", async () => {
    await withDB((db) => {
      writeFileSync(db, "/f", new TextEncoder().encode("old"), {}, () => 0);
      openWriteBufferSync(db, "/f");
      writeRangeSync(db, "/f", new TextEncoder().encode("new"), 0, {}, () => 1);
      chmod(db, "/f", 0o700, () => 2);
      releaseWriteBufferSync(db, "/f", () => 3);
      expect(resolveInode(db, "/f")?.mode).toBe(0o700);
    });
  });
});
