import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { createNodeVirtualFileSystem } from "./index.js";

// A temp directory that removes itself when the calling test ends.
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "computerd-vfs-store-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("createNodeVirtualFileSystem returns a @platformatic/vfs filesystem", async () => {
  const { vfs } = await createNodeVirtualFileSystem();

  vfs.mkdirSync("/project", { recursive: true });
  vfs.writeFileSync("/project/hello.txt", Buffer.from("hello"));

  expect(vfs.readdirSync("/")).toEqual(["project"]);
  expect(vfs.readdirSync("/project")).toEqual(["hello.txt"]);
  expect(vfs.readFileSync("/project/hello.txt").toString()).toBe("hello");

  vfs.renameSync("/project/hello.txt", "/project/greeting.txt");
  expect(vfs.existsSync("/project/hello.txt")).toBe(false);
  expect(vfs.readFileSync("/project/greeting.txt").toString()).toBe("hello");

  vfs.unlinkSync("/project/greeting.txt");
  expect(vfs.readdirSync("/project")).toEqual([]);
});

describe("createNodeVirtualFileSystem store selection", () => {
  test("defaults to an in-memory store", async () => {
    const handle = await createNodeVirtualFileSystem();
    expect(handle.store).toEqual({ kind: "memory" });
    handle.close();
  });

  test("an in-memory store starts empty on every call", async () => {
    const first = await createNodeVirtualFileSystem();
    first.vfs.writeFileSync("/only-in-first.txt", Buffer.from("x"));
    first.close();

    const second = await createNodeVirtualFileSystem();
    const exists = second.vfs.existsSync("/only-in-first.txt");
    second.close();

    expect(exists).toBe(false);
  });

  test("a file store keeps its files across close and reopen", async () => {
    const path = join(createTempDir(), "state.db");

    const first = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });
    first.vfs.mkdirSync("/workspace/repo", { recursive: true });
    first.vfs.writeFileSync("/workspace/repo/a.txt", Buffer.from("persisted"));
    first.close();

    const second = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: false },
    });
    const contents = second.vfs.readFileSync("/workspace/repo/a.txt").toString();
    second.close();

    expect(contents).toBe("persisted");
  });

  test("a file store reports the resolved path back to the caller", async () => {
    const path = join(createTempDir(), "state.db");
    const handle = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });
    const store = handle.store;
    handle.close();

    expect(store).toEqual({ kind: "file", path, fresh: true });
  });

  test("a file store forwards the extra dofs methods onto the vfs instance", async () => {
    const path = join(createTempDir(), "state.db");
    const handle = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });

    const forwarded = [
      "linkSync",
      "createFileSync",
      "writeRangeSync",
      "truncateFileSync",
      "chmodSync",
      "readRangeSync",
      "openWriteBufferSync",
      "openWriteBufferForCreateSync",
      "releaseWriteBufferSync",
    ] as const;
    const missing = forwarded.filter(
      (name) => typeof (handle.vfs as unknown as Record<string, unknown>)[name] !== "function",
    );
    handle.close();

    expect(missing).toEqual([]);
  });

  test("a file store serves range reads through the forwarded dofs method", async () => {
    const path = join(createTempDir(), "state.db");
    const handle = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });
    handle.vfs.writeFileSync("/ranged.txt", Buffer.from("abcdefghij"));

    const readRange = (handle.vfs as unknown as Record<string, unknown>).readRangeSync as (
      p: string,
      offset: number,
      length: number,
    ) => Uint8Array;
    const slice = Buffer.from(readRange("/ranged.txt", 2, 3)).toString();
    handle.close();

    expect(slice).toBe("cde");
  });

  test("refuses a store written by a newer schema version", async () => {
    const path = join(createTempDir(), "state.db");
    const first = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });
    first.db.run("UPDATE vfs_meta SET v = v + 1 WHERE k = ?", "schema_version");
    first.close();

    await expect(
      createNodeVirtualFileSystem({ store: { kind: "file", path, fresh: false } }),
    ).rejects.toThrow(/schema version/i);
  });

  test("migrates a store written by an older schema version", async () => {
    const path = join(createTempDir(), "state.db");
    const first = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: true },
    });
    first.vfs.writeFileSync("/pre-migration.txt", Buffer.from("kept"));
    const current = first.db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version");
    first.db.run("UPDATE vfs_meta SET v = ? WHERE k = ?", 2, "schema_version");
    first.close();

    const second = await createNodeVirtualFileSystem({
      store: { kind: "file", path, fresh: false },
    });
    const migrated = second.db.scalar<number>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    );
    const contents = second.vfs.readFileSync("/pre-migration.txt").toString();
    second.close();

    expect(migrated).toBe(current);
    expect(contents).toBe("kept");
  });
});
