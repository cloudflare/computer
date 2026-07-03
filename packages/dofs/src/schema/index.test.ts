import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Database } from "../storage.js";
import { RecordingStorage } from "../testing-recording.js";
import { SCHEMA_VERSION } from "./core.js";
import { initializeSchema } from "./index.js";

describe("initializeSchema", () => {
  it("lazily initializes the documented schema on first use", () => {
    const storage = new RecordingStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 1234);

    const executed = storage.statements.map((statement) => statement.query);
    expect(executed).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_meta"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_nodes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_dirents"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_blobs"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_blob_bytes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_chunks"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_manifests"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS vfs_changes"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS _vfs_watermark"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS _vfs_mounts"),
      ]),
    );
    expect(storage.statements).toContainEqual(
      expect.objectContaining({
        query: expect.stringContaining("INSERT OR IGNORE INTO vfs_nodes"),
        bindings: [1, 493, 1234],
      }),
    );
  });

  it("rejects a newer on-disk schema version", () => {
    const storage = new RecordingStorage({ schemaVersion: 999 });
    const db = new Database(storage);

    expect(() => initializeSchema(db, () => 0)).toThrow(
      /Unsupported workspace filesystem schema version 999/,
    );
  });

  it("stamps the current SCHEMA_VERSION in vfs_meta on a fresh DB", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);

    const row = db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version");
    expect(row?.v).toBe(SCHEMA_VERSION);
  });

  it("creates _vfs_mounts.mode on a fresh DB with the default and CHECK", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);

    // Defaults to read-only when the column is omitted.
    db.run("INSERT INTO _vfs_mounts (root, kind) VALUES (?, ?)", "/m1", "r2");
    const row = db.one<{ mode: string }>("SELECT mode FROM _vfs_mounts WHERE root = ?", "/m1");
    expect(row?.mode).toBe("read-only");

    // Explicit read-write is accepted.
    db.run(
      "INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)",
      "/m2",
      "r2",
      "read-write",
    );
    const row2 = db.one<{ mode: string }>("SELECT mode FROM _vfs_mounts WHERE root = ?", "/m2");
    expect(row2?.mode).toBe("read-write");

    // The CHECK constraint rejects anything else.
    expect(() =>
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)", "/m3", "r2", "bogus"),
    ).toThrow(/CHECK constraint/);
  });

  it("upgrades a v1 database to the current SCHEMA_VERSION", () => {
    // Stage a database at the old shape: _vfs_mounts without the
    // mode column, vfs_meta.schema_version = 1. The baseline DDL
    // run by initializeSchema is "IF NOT EXISTS" so it won't touch
    // the existing _vfs_mounts; the migration must.
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    db.transactionSync(() => {
      db.run(
        `CREATE TABLE vfs_meta (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE _vfs_mounts (
          root    TEXT PRIMARY KEY,
          kind    TEXT NOT NULL,
          indexed INTEGER NOT NULL DEFAULT 0
        )`,
      );
      db.run("INSERT INTO _vfs_mounts (root, kind, indexed) VALUES (?, ?, ?)", "/m1", "r2", 1);
      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 1);
    });

    initializeSchema(db, () => 0);

    // Version bumped.
    const versionRow = db.one<{ v: number }>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    );
    expect(versionRow?.v).toBe(SCHEMA_VERSION);

    // Existing row preserved and stamped with the conservative
    // default so a re-index pass has to opt back into read-write.
    const row = db.one<{ root: string; mode: string; indexed: number }>(
      "SELECT root, mode, indexed FROM _vfs_mounts WHERE root = ?",
      "/m1",
    );
    expect(row).toEqual({ root: "/m1", mode: "read-only", indexed: 1 });

    // Post-migration the CHECK constraint is live.
    expect(() =>
      db.run("INSERT INTO _vfs_mounts (root, kind, mode) VALUES (?, ?, ?)", "/m2", "r2", "bogus"),
    ).toThrow(/CHECK constraint/);
  });

  it("backfills vfs_nodes.size from chunk sums on the v2 -> v3 upgrade", () => {
    // Stage a database at the v2 shape: vfs_nodes without the
    // `size` column, schema_version = 2. The migration adds the
    // column with a default of 0 and then UPDATEs it from the
    // SUM of vfs_chunks.size for each file inode.
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    db.transactionSync(() => {
      db.run(
        `CREATE TABLE vfs_meta (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE vfs_nodes (
          inode         INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
          mode          INTEGER NOT NULL DEFAULT 493,
          mtime         INTEGER NOT NULL,
          rev           INTEGER NOT NULL DEFAULT 0,
          mount_root    TEXT,
          stub_size     INTEGER,
          manifest_hash BLOB,
          link_target   TEXT
        )`,
      );
      db.run(
        `CREATE TABLE vfs_chunks (
          inode INTEGER NOT NULL,
          idx   INTEGER NOT NULL,
          hash  BLOB    NOT NULL,
          size  INTEGER NOT NULL,
          PRIMARY KEY (inode, idx)
        )`,
      );
      // A live file with two chunks summing to 7 bytes, a live dir,
      // and a live file with no chunks (empty file).
      db.run(
        `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev) VALUES
           (1, 'dir', 493, 0, 0),
           (2, 'file', 420, 0, 0),
           (3, 'file', 420, 0, 0)`,
      );
      db.run(
        "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
        2,
        0,
        new Uint8Array(32),
        3,
      );
      db.run(
        "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
        2,
        1,
        new Uint8Array(32),
        4,
      );
      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 2);
    });

    initializeSchema(db, () => 0);

    const sizes = db.all<{ inode: number; size: number }>(
      "SELECT inode, size FROM vfs_nodes ORDER BY inode",
    );
    expect(sizes).toEqual([
      { inode: 1, size: 0 },
      { inode: 2, size: 7 },
      { inode: 3, size: 0 },
    ]);
  });

  it("upgrades a v3 database, backfilling _vfs_watermark with the default backend", () => {
    // Stage a database at the v3 shape: _vfs_watermark with the
    // old single-column primary key, two existing rows; vfs_nodes
    // already has the size column from the v2 -> v3 migration.
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    db.transactionSync(() => {
      db.run(
        `CREATE TABLE vfs_meta (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE _vfs_watermark (
          k TEXT PRIMARY KEY,
          v INTEGER NOT NULL
        )`,
      );
      db.run("INSERT INTO _vfs_watermark (k, v) VALUES (?, ?)", "pushRev", 42);
      db.run("INSERT INTO _vfs_watermark (k, v) VALUES (?, ?)", "fetchRev", 17);
      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 3);
    });

    initializeSchema(db, () => 0);

    // Version bumped.
    const versionRow = db.one<{ v: number }>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    );
    expect(versionRow?.v).toBe(SCHEMA_VERSION);

    // Existing rows preserved under the default backend slot.
    const push = db.one<{ k: string; backend: string; v: number }>(
      "SELECT k, backend, v FROM _vfs_watermark WHERE k = ?",
      "pushRev",
    );
    expect(push).toEqual({ k: "pushRev", backend: "default", v: 42 });
    const fetch = db.one<{ k: string; backend: string; v: number }>(
      "SELECT k, backend, v FROM _vfs_watermark WHERE k = ?",
      "fetchRev",
    );
    expect(fetch).toEqual({ k: "fetchRev", backend: "default", v: 17 });

    // The composite PK is live: same key under a different backend
    // is allowed and doesn't collide with the migrated row.
    db.run("INSERT INTO _vfs_watermark (k, backend, v) VALUES (?, ?, ?)", "pushRev", "worker", 99);
    const worker = db.one<{ v: number }>(
      "SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?",
      "pushRev",
      "worker",
    );
    expect(worker?.v).toBe(99);
  });

  it("rebuilds vfs_dirents and vfs_chunks as WITHOUT ROWID on the v4 -> v5 upgrade, preserving all data", () => {
    // Stage a v4-shape database: vfs_dirents and vfs_chunks are plain
    // rowid tables carrying their secondary indexes; vfs_nodes already
    // has the size column. Populate a representative graph — nested
    // dirs, a hardlink (one inode, two names), multi-chunk files, and
    // content dedup (distinct files sharing blob hashes) — so the
    // rebuild is proven lossless, not merely structurally correct.
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    const hashA = new Uint8Array(32).fill(0xaa);
    const hashB = new Uint8Array(32).fill(0xbb);

    db.transactionSync(() => {
      db.run(`CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
      db.run(
        `CREATE TABLE vfs_nodes (
          inode         INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
          mode          INTEGER NOT NULL DEFAULT 493,
          mtime         INTEGER NOT NULL,
          rev           INTEGER NOT NULL DEFAULT 0,
          mount_root    TEXT,
          stub_size     INTEGER,
          manifest_hash BLOB,
          link_target   TEXT,
          size          INTEGER NOT NULL DEFAULT 0
        )`,
      );
      // Pre-migration shape: rowid tables plus their secondary indexes.
      db.run(
        `CREATE TABLE vfs_dirents (
          parent_inode INTEGER NOT NULL,
          name         TEXT    NOT NULL,
          child_inode  INTEGER NOT NULL,
          PRIMARY KEY (parent_inode, name)
        )`,
      );
      db.run(`CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)`);
      db.run(
        `CREATE TABLE vfs_chunks (
          inode INTEGER NOT NULL,
          idx   INTEGER NOT NULL,
          hash  BLOB    NOT NULL,
          size  INTEGER NOT NULL,
          PRIMARY KEY (inode, idx)
        )`,
      );
      db.run(`CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash)`);
      db.run(
        `CREATE TABLE vfs_blobs (
          hash      BLOB    PRIMARY KEY,
          size      INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE vfs_blob_bytes (
          hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
          bytes BLOB NOT NULL
        )`,
      );

      // Graph: /(1) -> a(2) -> { f1(3), f2(4), b(5) }, b(5) -> deep(6).
      // Hardlink: /a/hard is a second name for inode 3.
      db.run(
        `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, size) VALUES
           (1, 'dir',  493, 0, 0, 0),
           (2, 'dir',  493, 0, 1, 0),
           (3, 'file', 420, 0, 2, 10),
           (4, 'file', 420, 0, 3, 5),
           (5, 'dir',  493, 0, 4, 0),
           (6, 'file', 420, 0, 5, 5)`,
      );
      db.run(
        `INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES
           (1, 'a',    2),
           (2, 'f1',   3),
           (2, 'f2',   4),
           (2, 'hard', 3),
           (2, 'b',    5),
           (5, 'deep', 6)`,
      );
      // f1(3): hashA + hashB. f2(4): hashA (dedup). deep(6): hashB (dedup).
      // -> 4 chunk rows referencing 2 distinct blobs.
      db.run("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", 3, 0, hashA, 5);
      db.run("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", 3, 1, hashB, 5);
      db.run("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", 4, 0, hashA, 5);
      db.run("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", 6, 0, hashB, 5);
      db.run("INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?)", hashA, 5, 0);
      db.run("INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?)", hashB, 5, 0);
      db.run(
        "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)",
        hashA,
        new Uint8Array(5).fill(1),
      );
      db.run(
        "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)",
        hashB,
        new Uint8Array(5).fill(2),
      );

      db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 4);
    });

    // Snapshot the two rebuilt tables before migrating.
    const direntsBefore = db.all<{ parent_inode: number; name: string; child_inode: number }>(
      "SELECT parent_inode, name, child_inode FROM vfs_dirents ORDER BY parent_inode, name",
    );
    const chunksBefore = db.all<{ inode: number; idx: number; hash: Uint8Array; size: number }>(
      "SELECT inode, idx, hash, size FROM vfs_chunks ORDER BY inode, idx",
    );

    initializeSchema(db, () => 0);

    // (a) Version bumped.
    expect(db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version")?.v).toBe(
      SCHEMA_VERSION,
    );

    const tableSql = (name: string): string =>
      db.one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        name,
      )?.sql ?? "";

    // (b) Both targets are now WITHOUT ROWID; vfs_blob_bytes is untouched.
    expect(tableSql("vfs_dirents").toUpperCase()).toContain("WITHOUT ROWID");
    expect(tableSql("vfs_chunks").toUpperCase()).toContain("WITHOUT ROWID");
    expect(tableSql("vfs_blob_bytes").toUpperCase()).not.toContain("WITHOUT ROWID");

    // (c) Both secondary indexes survived the rebuild.
    const indexNames = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map((r) => r.name);
    expect(indexNames).toContain("vfs_dirents_by_child");
    expect(indexNames).toContain("vfs_chunks_by_hash");

    // The rebuild's temp tables are dropped — no leftovers.
    const tableNames = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    expect(tableNames).not.toContain("vfs_dirents_v4");
    expect(tableNames).not.toContain("vfs_chunks_v4");

    // (d) Data survived byte-for-byte.
    expect(
      db.all("SELECT parent_inode, name, child_inode FROM vfs_dirents ORDER BY parent_inode, name"),
    ).toEqual(direntsBefore);
    expect(db.all("SELECT inode, idx, hash, size FROM vfs_chunks ORDER BY inode, idx")).toEqual(
      chunksBefore,
    );
    // Hardlink preserved: inode 3 still reached by both names via the
    // recreated child index.
    expect(
      db.all<{ parent_inode: number; name: string }>(
        "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ? ORDER BY name",
        3,
      ),
    ).toEqual([
      { parent_inode: 2, name: "f1" },
      { parent_inode: 2, name: "hard" },
    ]);
    // Dedup intact: 4 chunk rows, 2 distinct blobs.
    expect(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_chunks")?.c).toBe(4);
    expect(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_blobs")?.c).toBe(2);
    expect(db.one<{ c: number }>("SELECT COUNT(DISTINCT hash) AS c FROM vfs_chunks")?.c).toBe(2);

    // (e) A fresh install lands the identical table shape (modulo
    // whitespace) as the migrated database.
    const fresh = new Database(new SQLiteTestStorage());
    initializeSchema(fresh, () => 0);
    const freshSql = (name: string): string =>
      fresh.one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        name,
      )?.sql ?? "";
    const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim().toUpperCase();
    expect(norm(tableSql("vfs_dirents"))).toBe(norm(freshSql("vfs_dirents")));
    expect(norm(tableSql("vfs_chunks"))).toBe(norm(freshSql("vfs_chunks")));
  });

  it("is idempotent across repeat calls", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 0);
    expect(() => initializeSchema(db, () => 0)).not.toThrow();

    const row = db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = ?", "schema_version");
    expect(row?.v).toBe(SCHEMA_VERSION);
  });
});
