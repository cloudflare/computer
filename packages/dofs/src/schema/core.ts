// Filesystem-side tables. These hold the inode graph and the
// content-addressed blob store. See docs/03_filesystem_schema.md.

// Bumped to 2 when `_vfs_mounts.mode` landed (read-only mount
// enforcement at the data layer). Bumped to 3 when `vfs_nodes`
// gained a cached `size` column so stat() doesn't have to SUM
// chunks on every call. Bumped to 4 when `_vfs_watermark` gained
// a `backend` column so a single workspace can host more than
// one backend with independent sync cursors. Bumped to 5 when
// `vfs_dirents` and `vfs_chunks` became WITHOUT ROWID: their
// composite-PK lookups now read straight from the PK b-tree leaf
// with no rowid indirection, and `child_inode` lives in the
// dirents leaf so the (parent, name) resolve read is covering
// (no separate index needed). See `schema/migrations.ts` for the
// migration list; `sync.ts` carries the fresh-install DDL.
export const SCHEMA_VERSION = 5;
export const ROOT_INODE = 1;

export const CORE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_nodes (
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
  // WITHOUT ROWID: the row lives in the (parent_inode, name) PK
  // b-tree leaf, so resolving a path segment reads child_inode
  // directly from the leaf — no autoindex -> rowid hop, and no
  // separate covering index. Legal here because the PK is composite
  // and the table has no AUTOINCREMENT. Existing databases are
  // rebuilt by the v4 -> v5 migration in schema/migrations.ts; keep
  // this DDL and that migrator's CREATE in lockstep.
  `CREATE TABLE IF NOT EXISTS vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS vfs_dirents_by_child ON vfs_dirents(child_inode)`,
  `CREATE INDEX IF NOT EXISTS vfs_nodes_by_rev ON vfs_nodes(rev)`,
  // gc/manifests checks every manifest row against vfs_nodes via a
  // correlated NOT EXISTS (manifest_hash = ?). Without this index
  // gc full-scans vfs_nodes per candidate manifest — O(N×M).
  // Partial because the column is null on every dir and symlink
  // node, and on files until they get their first content write.
  `CREATE INDEX IF NOT EXISTS vfs_nodes_by_manifest_hash
    ON vfs_nodes(manifest_hash) WHERE manifest_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
  // WITHOUT ROWID: clustered on (inode, idx) so a file's chunks are
  // stored and scanned in index order straight from the PK leaf.
  // Legal here — composite PK, no AUTOINCREMENT. The bytes live in
  // vfs_blob_bytes (content-addressed), so these rows stay small,
  // which is what WITHOUT ROWID wants. Rebuilt for existing DBs by
  // the v4 -> v5 migration; keep in lockstep with that migrator.
  `CREATE TABLE IF NOT EXISTS vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS vfs_chunks_by_hash ON vfs_chunks(hash)`,
] as const;
