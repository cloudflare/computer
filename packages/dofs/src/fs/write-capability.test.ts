import { describe, expect, it } from "vitest";

import { SQLiteWorkspaceProvider } from "../provider.js";
import { WorkspaceFilesystem } from "./filesystem.js";
import { withDB } from "./with-db.js";

const clock = () => 1000;

describe("WorkspaceFilesystem write capability", () => {
  it("defaults to writable so existing callers are unaffected", async () => {
    await withDB(async (db) => {
      const fs = new WorkspaceFilesystem(db, { now: clock });

      await fs.mkdir("/workspace", { recursive: true });
      await fs.writeFile("/workspace/hello.txt", "hi");

      expect(await fs.readFile("/workspace/hello.txt", "utf8")).toBe("hi");
    });
  });

  it("rejects writeFile with EROFS on a read-only handle", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      await writable.mkdir("/workspace", { recursive: true });

      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });
      await expect(readOnly.writeFile("/workspace/hello.txt", "hi")).rejects.toMatchObject({
        code: "EROFS",
      });

      await expect(writable.readFile("/workspace/hello.txt", "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects mkdir with EROFS on a read-only handle", async () => {
    await withDB(async (db) => {
      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });

      await expect(readOnly.mkdir("/workspace", { recursive: true })).rejects.toMatchObject({
        code: "EROFS",
      });
    });
  });

  it("rejects rm with EROFS on a read-only handle and leaves the file in place", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      await writable.mkdir("/workspace", { recursive: true });
      await writable.writeFile("/workspace/keep.txt", "still here");

      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });
      await expect(readOnly.rm("/workspace/keep.txt", {})).rejects.toMatchObject({ code: "EROFS" });

      expect(await writable.readFile("/workspace/keep.txt", "utf8")).toBe("still here");
    });
  });

  it("rejects chmod with EROFS on a read-only handle", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      await writable.mkdir("/workspace", { recursive: true });
      await writable.writeFile("/workspace/script.sh", "echo hi");

      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });
      await expect(readOnly.chmod("/workspace/script.sh", 0o755)).rejects.toMatchObject({
        code: "EROFS",
      });
    });
  });

  it("rejects symlink with EROFS on a read-only handle", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      await writable.mkdir("/workspace", { recursive: true });

      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });
      await expect(readOnly.symlink("/workspace", "/link")).rejects.toMatchObject({
        code: "EROFS",
      });
    });
  });

  it("serves every read from a read-only handle", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      await writable.mkdir("/workspace/sub", { recursive: true });
      await writable.writeFile("/workspace/a.txt", "alpha");
      await writable.writeFile("/workspace/sub/b.txt", "beta");

      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });

      expect(await readOnly.readFile("/workspace/a.txt", "utf8")).toBe("alpha");
      expect((await readOnly.stat("/workspace/a.txt")).size).toBe(5);
      expect((await readOnly.readdir("/workspace")).map((e) => e.name).sort()).toEqual([
        "a.txt",
        "sub",
      ]);
      expect(await readOnly.ls("/workspace")).toContain("/workspace/a.txt");
      expect(await readOnly.find("/workspace", "*.txt")).toEqual([
        { path: "/workspace/a.txt", type: "file" },
      ]);
      expect(await readOnly.grep("beta", "/workspace")).toHaveLength(1);
    });
  });

  // Two commands can be in flight against one workspace at the same
  // time, and they do not have to agree about write access. The
  // capability belongs to the handle rather than to the database, so
  // a read-only command cannot disarm a concurrent writable one, and
  // a writable command cannot lend its access to a read-only one.
  it("leaves a writable handle over the same database unaffected", async () => {
    await withDB(async (db) => {
      const writable = new WorkspaceFilesystem(db, { now: clock });
      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });

      await writable.mkdir("/workspace", { recursive: true });
      await expect(readOnly.writeFile("/workspace/denied.txt", "no")).rejects.toMatchObject({
        code: "EROFS",
      });

      await writable.writeFile("/workspace/allowed.txt", "yes");
      expect(await readOnly.readFile("/workspace/allowed.txt", "utf8")).toBe("yes");
    });
  });

  it("names the path it refused", async () => {
    await withDB(async (db) => {
      const readOnly = new WorkspaceFilesystem(db, { now: clock, writable: false });

      await expect(readOnly.writeFile("/workspace/hello.txt", "hi")).rejects.toMatchObject({
        code: "EROFS",
        path: "/workspace/hello.txt",
      });
    });
  });
});

describe("SQLiteWorkspaceProvider write capability", () => {
  it("advertises the capability through the readonly flag", async () => {
    await withDB(async (db) => {
      expect(new SQLiteWorkspaceProvider(db, { now: clock }).readonly).toBe(false);
      expect(new SQLiteWorkspaceProvider(db, { now: clock, writable: false }).readonly).toBe(true);
    });
  });

  it("rejects every mutating call with EROFS on a read-only provider", async () => {
    await withDB(async (db) => {
      const writable = new SQLiteWorkspaceProvider(db, { now: clock });
      writable.mkdirSync("/workspace", { recursive: true });
      writable.writeFileSync("/workspace/a.txt", "alpha");
      writable.mkdirSync("/workspace/dir", { recursive: true });

      const readOnly = new SQLiteWorkspaceProvider(db, { now: clock, writable: false });
      const refused = (run: () => unknown) =>
        expect(run).toThrowError(expect.objectContaining({ code: "EROFS" }));

      refused(() => readOnly.writeFileSync("/workspace/b.txt", "beta"));
      refused(() => readOnly.writeFileRangesSync("/workspace/a.txt", "x", [{ start: 0, end: 1 }]));
      refused(() => readOnly.mkdirSync("/workspace/other", { recursive: true }));
      refused(() => readOnly.rmdirSync("/workspace/dir"));
      refused(() => readOnly.unlinkSync("/workspace/a.txt"));
      refused(() => readOnly.renameSync("/workspace/a.txt", "/workspace/moved.txt"));
      refused(() => readOnly.linkSync("/workspace/a.txt", "/workspace/hard.txt"));
      refused(() => readOnly.symlinkSync("/workspace", "/link"));
      refused(() => readOnly.truncateSync("/workspace/a.txt", 0));
      refused(() => readOnly.createFileSync("/workspace/c.txt"));
      refused(() => readOnly.writeRangeSync("/workspace/a.txt", new Uint8Array([1]), 0));
      refused(() => readOnly.truncateFileSync("/workspace/a.txt", 0));
      refused(() => readOnly.openSync("/workspace/new.txt", "w"));

      // These four reached the database without consulting the guard
      // before the capability existed. A read-only command drives all
      // of them through a FUSE mount, so they are the ones worth
      // naming.
      refused(() => readOnly.chmodSync("/workspace/a.txt", 0o755));
      refused(() => readOnly.openWriteBufferSync("/workspace/a.txt"));
      refused(() => readOnly.openWriteBufferForCreateSync("/workspace/d.txt"));
      refused(() => readOnly.releaseWriteBufferSync("/workspace/a.txt"));

      // Nothing landed.
      expect(writable.readFileSync("/workspace/a.txt", "utf8")).toBe("alpha");
      expect(writable.existsSync("/workspace/b.txt")).toBe(false);
      expect(writable.existsSync("/workspace/dir")).toBe(true);
    });
  });

  // Opening for write on a read-only filesystem fails at the open,
  // not later on the first write, so a read-only provider never hands
  // out a writable descriptor. The write path is guarded too, which
  // covers a descriptor obtained some other way.
  it("refuses to open a file for writing", async () => {
    await withDB(async (db) => {
      const writable = new SQLiteWorkspaceProvider(db, { now: clock });
      writable.mkdirSync("/workspace", { recursive: true });
      writable.writeFileSync("/workspace/a.txt", "alpha");

      const readOnly = new SQLiteWorkspaceProvider(db, { now: clock, writable: false });
      for (const flags of ["w", "a", "r+", "w+"]) {
        expect(() => readOnly.openSync("/workspace/a.txt", flags)).toThrowError(
          expect.objectContaining({ code: "EROFS" }),
        );
      }

      expect(writable.readFileSync("/workspace/a.txt", "utf8")).toBe("alpha");
    });
  });

  it("serves reads from a read-only provider", async () => {
    await withDB(async (db) => {
      const writable = new SQLiteWorkspaceProvider(db, { now: clock });
      writable.mkdirSync("/workspace", { recursive: true });
      writable.writeFileSync("/workspace/a.txt", "alpha");

      const readOnly = new SQLiteWorkspaceProvider(db, { now: clock, writable: false });

      expect(readOnly.readFileSync("/workspace/a.txt", "utf8")).toBe("alpha");
      expect(readOnly.statSync("/workspace/a.txt").size).toBe(5);
      expect(readOnly.readdirSync("/workspace")).toEqual(["a.txt"]);
      expect(readOnly.existsSync("/workspace/a.txt")).toBe(true);
      const fd = readOnly.openSync("/workspace/a.txt", "r");
      readOnly.closeSync(fd);
    });
  });
});
