import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Database } from "../storage.js";
import { stageBlob } from "../sync/blobs.js";
import { mkdir } from "./mkdir.js";
import {
  assertNotReadOnly,
  getReadOnlyMountRoots,
  invalidateReadOnlyMountCache,
} from "./mount-guard.js";
import { rename } from "./rename.js";
import { resolveInode } from "./resolve.js";
import { rm } from "./rm.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import {
  createFileSync,
  linkStagedChunksSync,
  openWriteBufferForCreateSync,
  openWriteBufferSync,
  releaseWriteBufferSync,
  truncateFileSync,
  writeFile,
  writeFileRangesSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile.js";

// Stage a read-only mount the way the workspace-side indexer
// eventually will: a row in `_vfs_mounts` plus an actual subtree
// stamped with `mount_root`. Tests that want the cache to pick this
// up should invalidate it after staging.
function stageMount(db: Database, root: string, mode: "read-only" | "read-write"): void {
  db.run(
    "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, ?)",
    root,
    "test",
    mode,
  );
  invalidateReadOnlyMountCache(db);
}

// Create a stub directory hierarchy at the mount root, stamped with
// `mount_root`. The guard only consults `_vfs_mounts`, so for the
// rm tests we materialise enough of the subtree for the walk to
// find something to delete.
async function materialiseRootDir(db: Database, root: string, now: () => number): Promise<void> {
  mkdir(db, root, { recursive: true }, now);
  // Stamp the inode so a later "drop the workspace.mount_root
  // column" sweep would notice if anything else relies on it.
  db.run(
    "UPDATE vfs_nodes SET mount_root = ? WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE name = ? AND parent_inode = 1)",
    root,
    root.slice(1),
  );
}

describe("mount-guard helpers", () => {
  it("caches read-only roots per database and reloads after invalidation", async () => {
    await withDB(async (db) => {
      // Cold cache: empty list, no rows.
      expect(getReadOnlyMountRoots(db)).toEqual([]);

      // Stage a row without invalidating; cache stays empty.
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, 'read-only')",
        "/workspace/r2",
        "r2",
      );
      expect(getReadOnlyMountRoots(db)).toEqual([]);

      // After invalidation the next call re-reads.
      invalidateReadOnlyMountCache(db);
      expect(getReadOnlyMountRoots(db)).toEqual(["/workspace/r2"]);

      // A read-write row stays out of the read-only set.
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, 'read-write')",
        "/workspace/scratch",
        "r2",
      );
      invalidateReadOnlyMountCache(db);
      expect(getReadOnlyMountRoots(db)).toEqual(["/workspace/r2"]);
    });
  });

  it("assertNotReadOnly is a no-op when no read-only mounts are registered", async () => {
    await withDB(async (db) => {
      expect(() => assertNotReadOnly(db, "/anywhere")).not.toThrow();
    });
  });

  it("assertNotReadOnly throws EROFS for paths under, at, or above a read-only root", async () => {
    await withDB(async (db) => {
      stageMount(db, "/workspace/r2", "read-only");

      // Direct paths inside.
      expect(() => assertNotReadOnly(db, "/workspace/r2/hello.txt")).toThrow(/EROFS|read-only/);
      // Path equal to the mount root.
      expect(() => assertNotReadOnly(db, "/workspace/r2")).toThrow(/EROFS|read-only/);
      // Ancestor of the mount root (the rm-the-whole-workspace
      // shape).
      expect(() => assertNotReadOnly(db, "/workspace")).toThrow(/EROFS|read-only/);

      // Paths outside the mount are fine.
      expect(() => assertNotReadOnly(db, "/workspace/r2-sibling")).not.toThrow();
      expect(() => assertNotReadOnly(db, "/scratch/elsewhere")).not.toThrow();
    });
  });

  it("read-write mounts do not register as read-only", async () => {
    await withDB(async (db) => {
      stageMount(db, "/workspace/rw", "read-write");
      expect(getReadOnlyMountRoots(db)).toEqual([]);
      expect(() => assertNotReadOnly(db, "/workspace/rw/file")).not.toThrow();
    });
  });
});

describe("writeFile under a read-only mount", () => {
  it("rejects a streaming write under the mount root with EROFS", async () => {
    await withDB(async (db) => {
      // Materialise the directory before flipping the mount to
      // read-only so the guard doesn't block our own setup.
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      const source = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("blocked"));
          c.close();
        },
      });
      await expect(
        writeFile(db, "/workspace/r2/hello.txt", source, {}, () => 0),
      ).rejects.toMatchObject({ code: "EROFS" });

      // The reject happens before we stage blobs, so no orphan
      // rows land.
      const blobs = db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
      expect(blobs).toBe(0);
    });
  });

  it("rejects writeFileSync under the mount root with EROFS", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      expect(() =>
        writeFileSync(db, "/workspace/r2/hello.txt", new Uint8Array([1, 2, 3]), {}, () => 0),
      ).toThrow(/EROFS|read-only/);
    });
  });

  it("rejects streaming writes through a symlinked parent before staging blobs", async () => {
    await withDB(async (db) => {
      mkdir(db, "/mnt", {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );

      await expect(writeFile(db, "/linkdir/new.txt", source, {}, () => 0)).rejects.toMatchObject({
        code: "EROFS",
      });
      expect(pulls).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs")).toBe(0);
    });
  });

  it("rejects writeFileSync through a symlinked parent into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() =>
        writeFileSync(db, "/linkdir/new.txt", new Uint8Array([1]), {}, () => 0),
      ).toThrowError(expect.objectContaining({ code: "EROFS" }));
      expect(resolveInode(db, "/mnt/new.txt")).toBeNull();
    });
  });

  it("rejects a final symlink target that escapes a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      mkdir(db, "/outside", {}, () => 0);
      symlink(db, "/outside", "/mnt/escape", () => 0);
      symlink(db, "/mnt/escape/file.txt", "/entry", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() => writeFileSync(db, "/entry", new Uint8Array([1]), {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(resolveInode(db, "/outside/file.txt")).toBeNull();
    });
  });

  it("rejects an intermediate symlink target that escapes a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      mkdir(db, "/outside", {}, () => 0);
      symlink(db, "/outside", "/mnt/escape", () => 0);
      symlink(db, "/mnt/escape", "/entry", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() =>
        writeFileSync(db, "/entry/file.txt", new Uint8Array([1]), {}, () => 0),
      ).toThrowError(expect.objectContaining({ code: "EROFS" }));
      expect(resolveInode(db, "/outside/file.txt")).toBeNull();
    });
  });

  it("rejects file creation through a symlinked parent into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() => createFileSync(db, "/linkdir/new.txt", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
    });
  });

  it("rejects buffered creation through a symlinked parent into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() => openWriteBufferForCreateSync(db, "/linkdir/new.txt", {}, () => 0)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
    });
  });

  it("rechecks the lexical path when a pending create is released", async () => {
    await withDB((db) => {
      mkdir(db, "/actual", {}, () => 0);
      symlink(db, "/actual", "/linkdir", () => 0);
      openWriteBufferForCreateSync(db, "/linkdir/new.txt", {}, () => 0);
      stageMount(db, "/linkdir", "read-only");

      expect(() => openWriteBufferSync(db, "/linkdir/new.txt")).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(() => releaseWriteBufferSync(db, "/linkdir/new.txt", () => 1)).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );
      expect(resolveInode(db, "/actual/new.txt")).toBeNull();
    });
  });

  it.each([
    [
      "whole-file range write",
      (db: Database) =>
        writeFileRangesSync(
          db,
          "/linkdir/file.txt",
          new TextEncoder().encode("new"),
          [{ start: 0, end: 3 }],
          {},
          () => 1,
        ),
    ],
    [
      "positional write",
      (db: Database) =>
        writeRangeSync(db, "/linkdir/file.txt", new Uint8Array([1]), 0, {}, () => 1),
    ],
    ["truncate", (db: Database) => truncateFileSync(db, "/linkdir/file.txt", 0, () => 1)],
  ])("rejects %s through a symlinked parent into a read-only mount", async (_name, write) => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      writeFileSync(db, "/mnt/file.txt", new TextEncoder().encode("old"), {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");

      expect(() => write(db)).toThrowError(expect.objectContaining({ code: "EROFS" }));
    });
  });

  it("rejects linkStagedChunksSync under the mount root with EROFS", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      const bytes = new TextEncoder().encode("blocked");
      const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
      stageBlob(db, hash, bytes, 0);

      expect(() =>
        linkStagedChunksSync(
          db,
          "/workspace/r2/hello.txt",
          ["workspace", "r2", "hello.txt"],
          [{ hash, size: bytes.byteLength }],
          {},
          0,
        ),
      ).toThrow(/EROFS|read-only/);
      expect(resolveInode(db, "/workspace/r2/hello.txt")).toBeNull();
    });
  });

  it("rejects staged writes through a symlinked parent into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", {}, () => 0);
      symlink(db, "/mnt", "/linkdir", () => 0);
      stageMount(db, "/mnt", "read-only");
      const bytes = new TextEncoder().encode("blocked");
      const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
      stageBlob(db, hash, bytes, 0);

      expect(() =>
        linkStagedChunksSync(
          db,
          "/linkdir/new.txt",
          ["linkdir", "new.txt"],
          [{ hash, size: bytes.byteLength }],
          {},
          0,
        ),
      ).toThrowError(expect.objectContaining({ code: "EROFS" }));
      expect(resolveInode(db, "/mnt/new.txt")).toBeNull();
    });
  });

  it("allows writes under a read-write mount", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/rw", { recursive: true }, () => 0);
      stageMount(db, "/workspace/rw", "read-write");

      // No throw; the bytes land in vfs_nodes.
      writeFileSync(db, "/workspace/rw/ok.txt", new TextEncoder().encode("hi"), {}, () => 0);
      const inode = db.scalar<number>(
        "SELECT inode FROM vfs_nodes WHERE manifest_hash IS NOT NULL",
      );
      expect(inode).toBeDefined();
    });
  });
});

describe("mkdir under a read-only mount", () => {
  it("rejects mkdir under the mount root with EROFS", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      expect(() => mkdir(db, "/workspace/r2/sub", { recursive: true }, () => 0)).toThrow(
        /EROFS|read-only/,
      );
    });
  });

  it("rejects mkdir of a read-only mount root that doesn't exist yet", async () => {
    await withDB(async (db) => {
      stageMount(db, "/workspace/r2", "read-only");
      expect(() => mkdir(db, "/workspace/r2", { recursive: true }, () => 0)).toThrow(
        /EROFS|read-only/,
      );
    });
  });
});

describe("rm under a read-only mount", () => {
  it("rejects rm of a path inside the mount", async () => {
    await withDB(async (db) => {
      // Stage the row, materialise the subtree before stamping
      // read-only so writeFile can land a file.
      stageMount(db, "/workspace/r2", "read-write");
      await materialiseRootDir(db, "/workspace/r2", () => 0);
      writeFileSync(db, "/workspace/r2/hello.txt", new Uint8Array([1]), {}, () => 0);

      // Flip to read-only.
      db.run("UPDATE _vfs_mounts SET mode = 'read-only' WHERE root = ?", "/workspace/r2");
      invalidateReadOnlyMountCache(db);

      expect(() => rm(db, "/workspace/r2/hello.txt", {})).toThrow(/EROFS|read-only/);
    });
  });

  it("rejects rm of the mount root itself", async () => {
    await withDB(async (db) => {
      await materialiseRootDir(db, "/workspace/r2", () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      expect(() => rm(db, "/workspace/r2", { recursive: true, force: true })).toThrow(
        /EROFS|read-only/,
      );
    });
  });

  it("rejects rm of an ancestor whose subtree contains a read-only mount", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      // The ancestor path /workspace overlaps the read-only root
      // via the symmetric check; rm with recursive/force must
      // reject before deleting anything.
      expect(() => rm(db, "/workspace", { recursive: true, force: true })).toThrow(
        /EROFS|read-only/,
      );

      // The mount root inode is still present.
      const remaining = db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents WHERE name = ?", "r2");
      expect(remaining).toBeGreaterThan(0);
    });
  });

  it("allows rm of a path outside any mount", async () => {
    await withDB(async (db) => {
      mkdir(db, "/scratch", { recursive: true }, () => 0);
      writeFileSync(db, "/scratch/file.txt", new Uint8Array([1]), {}, () => 0);
      stageMount(db, "/workspace/r2", "read-only");

      expect(() => rm(db, "/scratch/file.txt", {})).not.toThrow();
    });
  });

  it("allows rm under a read-write mount", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/rw", { recursive: true }, () => 0);
      writeFileSync(db, "/workspace/rw/hi.txt", new Uint8Array([1]), {}, () => 0);
      stageMount(db, "/workspace/rw", "read-write");

      expect(() => rm(db, "/workspace/rw/hi.txt", {})).not.toThrow();
    });
  });

  it("rejects rm through a symlinked parent that resolves into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", { recursive: true }, () => 0);
      writeFileSync(db, "/mnt/file.txt", new Uint8Array([1]), {}, () => 0);
      symlink(db, "/mnt", "/link", () => 0);
      stageMount(db, "/mnt", "read-only");
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => rm(db, "/link/file.txt", {})).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );

      expect(resolveInode(db, "/mnt/file.txt")).not.toBeNull();
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'")).toBe(before);
    });
  });

  it("rejects recursive rm of a directory inside a read-only mount via a symlinked parent", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt/dir", { recursive: true }, () => 0);
      writeFileSync(db, "/mnt/dir/file.txt", new Uint8Array([1]), {}, () => 0);
      symlink(db, "/mnt", "/link", () => 0);
      stageMount(db, "/mnt", "read-only");
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => rm(db, "/link/dir", { recursive: true })).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );

      expect(resolveInode(db, "/mnt/dir/file.txt")).not.toBeNull();
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'")).toBe(before);
    });
  });
});

describe("rename under a read-only mount", () => {
  it("rejects rename from a symlinked parent that resolves into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", { recursive: true }, () => 0);
      writeFileSync(db, "/mnt/file.txt", new Uint8Array([1]), {}, () => 0);
      symlink(db, "/mnt", "/link", () => 0);
      stageMount(db, "/mnt", "read-only");
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => rename(db, "/link/file.txt", "/moved.txt")).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );

      expect(resolveInode(db, "/mnt/file.txt")).not.toBeNull();
      expect(resolveInode(db, "/moved.txt")).toBeNull();
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'")).toBe(before);
    });
  });

  it("rejects rename to a symlinked parent that resolves into a read-only mount", async () => {
    await withDB((db) => {
      mkdir(db, "/mnt", { recursive: true }, () => 0);
      writeFileSync(db, "/src.txt", new Uint8Array([1]), {}, () => 0);
      symlink(db, "/mnt", "/link", () => 0);
      stageMount(db, "/mnt", "read-only");
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;

      expect(() => rename(db, "/src.txt", "/link/file.txt")).toThrowError(
        expect.objectContaining({ code: "EROFS" }),
      );

      expect(resolveInode(db, "/src.txt")).not.toBeNull();
      expect(resolveInode(db, "/mnt/file.txt")).toBeNull();
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'")).toBe(before);
    });
  });
});
