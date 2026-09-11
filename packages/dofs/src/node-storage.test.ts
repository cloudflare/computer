import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceFilesystem } from "./fs/filesystem.js";
import { NodeSQLiteStorage } from "./node-storage.js";
import { initializeSchema, ROOT_INODE, SCHEMA_VERSION } from "./schema/index.js";
import { Database } from "./storage.js";
import {
  readFetchCursor,
  readPushCursor,
  writeFetchCursor,
  writePushCursor,
} from "./sync/watermarks.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dofs-node-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openStore(path: string): { storage: NodeSQLiteStorage; db: Database } {
  const storage = new NodeSQLiteStorage({ location: path });
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  return { storage, db };
}

describe("NodeSQLiteStorage on a file", () => {
  it("keeps files and their bytes across a close and reopen", async () => {
    const path = join(dir, "state.db");

    const first = openStore(path);
    const fs = new WorkspaceFilesystem(first.db, { now: () => 1000 });
    await fs.mkdir("/workspace/repo", { recursive: true });
    await fs.writeFile("/workspace/repo/a.txt", "hello from the first process");
    first.storage.close();

    const second = openStore(path);
    const reopened = new WorkspaceFilesystem(second.db, { now: () => 2000 });
    const contents = await reopened.readFile("/workspace/repo/a.txt", "utf8");
    second.storage.close();

    expect(contents).toBe("hello from the first process");
  });

  it("keeps the sync cursors across a close and reopen", () => {
    const path = join(dir, "state.db");

    const first = openStore(path);
    writePushCursor(first.db, { rev: 42, path: null });
    writeFetchCursor(first.db, { rev: 41, path: "/workspace/b.txt" });
    first.storage.close();

    const second = openStore(path);
    const push = readPushCursor(second.db);
    const fetch = readFetchCursor(second.db);
    second.storage.close();

    expect(push).toEqual({ rev: 42, path: null });
    expect(fetch).toEqual({ rev: 41, path: "/workspace/b.txt" });
  });

  it("does not re-seed the root inode when reopening an existing store", () => {
    const path = join(dir, "state.db");

    const first = openStore(path);
    first.db.run("UPDATE vfs_nodes SET mtime = ? WHERE inode = ?", 5555, ROOT_INODE);
    first.storage.close();

    const second = openStore(path);
    const mtime = second.db.scalar<number>(
      "SELECT mtime FROM vfs_nodes WHERE inode = ?",
      ROOT_INODE,
    );
    const version = second.db.scalar<number>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    );
    second.storage.close();

    expect(mtime).toBe(5555);
    expect(version).toBe(SCHEMA_VERSION);
  });

  it("turns on write-ahead logging", () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);

    const mode = db.scalar<string>("PRAGMA journal_mode");
    storage.close();

    expect(mode).toBe("wal");
  });

  it("converts a byte cache budget into SQLite's negative kibibyte form", () => {
    const path = join(dir, "state.db");
    const storage = new NodeSQLiteStorage({
      location: path,
      cacheSizeBytes: 64 * 1024 * 1024,
    });
    const db = new Database(storage);

    const cacheSize = db.scalar<number>("PRAGMA cache_size");
    storage.close();

    expect(cacheSize).toBe(-65536);
  });

  it("applies the memory map size it was given", () => {
    const path = join(dir, "state.db");
    const storage = new NodeSQLiteStorage({
      location: path,
      mmapSizeBytes: 256 * 1024 * 1024,
    });
    const db = new Database(storage);

    const mmapSize = db.scalar<number>("PRAGMA mmap_size");
    storage.close();

    expect(mmapSize).toBe(268435456);
  });

  it("applies the synchronous level it was given", () => {
    const path = join(dir, "state.db");
    const storage = new NodeSQLiteStorage({ location: path, synchronous: "normal" });
    const db = new Database(storage);

    const level = db.scalar<number>("PRAGMA synchronous");
    storage.close();

    expect(level).toBe(1);
  });

  it("keeps temporary tables in memory", () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);

    const tempStore = db.scalar<number>("PRAGMA temp_store");
    storage.close();

    expect(tempStore).toBe(2);
  });

  it("creates the database file when it does not exist", async () => {
    const path = join(dir, "nested", "state.db");
    const { storage, db } = openStore(path);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });

    await fs.writeFile("/probe.txt", "x");
    storage.close();

    const reopened = openStore(path);
    const contents = await new WorkspaceFilesystem(reopened.db).readFile("/probe.txt", "utf8");
    reopened.storage.close();

    expect(contents).toBe("x");
  });

  it("leaves the store readable after a checkpoint", async () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    await fs.writeFile("/checkpointed.txt", "still here");

    storage.checkpoint();

    const contents = await fs.readFile("/checkpointed.txt", "utf8");
    storage.close();

    expect(contents).toBe("still here");
  });

  it("reports the bytes a checkpoint folded back into the main file", async () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    await fs.writeFile("/sized.txt", "x".repeat(4096));

    const result = storage.checkpoint();
    storage.close();

    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("rolls back a failed transaction", () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);

    expect(() => {
      db.transactionSync(() => {
        db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "rollback_probe", 1);
        throw new Error("forced");
      });
    }).toThrow("forced");

    const value = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "rollback_probe");
    storage.close();

    expect(value).toBeUndefined();
  });

  it("commits an inner savepoint while the outer transaction continues", () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);

    db.transactionSync(() => {
      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "outer", 1);
      db.transactionSync(() => {
        db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "inner", 2);
      });
    });

    const outer = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "outer");
    const inner = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "inner");
    storage.close();

    expect(outer).toBe(1);
    expect(inner).toBe(2);
  });

  it("rolls the outer transaction back over a committed inner savepoint", () => {
    const path = join(dir, "state.db");
    const { storage, db } = openStore(path);

    expect(() => {
      db.transactionSync(() => {
        db.transactionSync(() => {
          db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "nested_probe", 1);
        });
        throw new Error("forced");
      });
    }).toThrow("forced");

    const value = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "nested_probe");
    storage.close();

    expect(value).toBeUndefined();
  });
});

describe("NodeSQLiteStorage in memory", () => {
  it("accepts the in-memory location and serves a working schema", () => {
    const storage = new NodeSQLiteStorage({ location: ":memory:" });
    const db = new Database(storage);
    initializeSchema(db, () => 1234);

    const row = db.one<{ inode: number; type: string }>(
      "SELECT inode, type FROM vfs_nodes WHERE inode = ?",
      ROOT_INODE,
    );
    storage.close();

    expect(row).toEqual({ inode: ROOT_INODE, type: "dir" });
  });

  it("leaves journal mode alone for an in-memory store", () => {
    const storage = new NodeSQLiteStorage({ location: ":memory:" });
    const db = new Database(storage);

    const mode = db.scalar<string>("PRAGMA journal_mode");
    storage.close();

    expect(mode).toBe("memory");
  });

  it("reports nothing to fold when checkpointing an in-memory store", () => {
    const storage = new NodeSQLiteStorage({ location: ":memory:" });
    new Database(storage);

    const result = storage.checkpoint();
    storage.close();

    expect(result.walFrames).toBe(0);
  });
});
