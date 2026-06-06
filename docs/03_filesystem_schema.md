# 03. Filesystem Schema

> [!NOTE]
> This document describes the **target design** for the VFS schema.
> The DDL blocks below — every table, column, index, default, and
> check constraint — match what `main` ships today. A handful of
> behaviours layered on top of the schema (manifest binary encoding,
> `vfs_changes` pruning, `_vfs_mounts` usage) are forward-looking
> and called out inline.

The VFS lives in the Durable Object's SQLite. Every read and write
ultimately hits one of these tables. All tables are prefixed with
`vfs_` (or `_vfs_` for internal bookkeeping) so they don't
collide with application-owned tables in the same DO storage.

Paths are resolved through an inode-style indirection (`vfs_dirents`
→ `vfs_nodes`), so the local namespace move in a rename is O(1) and
hardlinks fall out for free. Directory rename sync still walks the
moved subtree because the wire represents the move as live entries at
the new paths plus tombstones at the old paths.

## Tables

### `vfs_meta` — schema version and singletons

```sql
CREATE TABLE vfs_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
```

Holds `schema_version` (bumped by every migration) and the singleton
revision counter row `rev`. Open() refuses to run if the binary is
older than the on-disk `schema_version`.

`rev` is bumped atomically on every mutation; the new value is stamped
into `vfs_nodes.rev` (or `vfs_changes.rev`) to drive incremental
sync. Mutations are serialized upstream by the Workspace FIFO (see
[02. Sync Protocol](./02_sync_protocol.md#failure-handling)), so this
single-row counter is never contended in practice — but it is
deliberately single-writer, and adding concurrent mutators would
require revisiting it.

### `vfs_nodes` — inode metadata

```sql
CREATE TABLE vfs_nodes (
  inode         INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
  mode          INTEGER NOT NULL DEFAULT 493,        -- 0o755
  mtime         INTEGER NOT NULL,                    -- ms since epoch
  rev           INTEGER NOT NULL DEFAULT 0,          -- last write's rev
  mount_root    TEXT,                                -- nullable; tags mount provenance
  stub_size     INTEGER,                             -- non-null while a lazy stub
  manifest_hash BLOB,                                -- references vfs_manifests.hash
  link_target   TEXT,                                -- non-null when type = 'symlink'
  size          INTEGER NOT NULL DEFAULT 0           -- cached file size, kept in sync on writes
);
CREATE INDEX vfs_nodes_by_rev ON vfs_nodes(rev);
```

One row per live inode. `mount_root` records the mount this row
originated from, used for write-rejection and writable-mount mirroring.
`stub_size` is non-null while the file is a lazy-mount stub whose
bytes haven't been fetched yet — `stat()` reports it as the file size
and the first read fetches the bytes. `size` denormalises the
chunk-sum file size onto the node row so `stat`, `lstat`, and the
positional read primitive can read it directly instead of running
`SUM(size) FROM vfs_chunks` on every call. Every write path stamps
it alongside `mode`/`mtime`/`rev`.

The `vfs_nodes_by_rev` index supports `coalesceChanges`'s cursor scan
over live inodes, which the sync protocol calls once per pull to
enumerate everything modified after the last fetch cursor.

There is no `ignored` column: ignored paths are entirely invisible to
the DO-side filesystem API (see
[02. Sync Protocol → Ignored entries](./02_sync_protocol.md#ignored-entries)).

### `vfs_dirents` — name → inode mapping

```sql
CREATE TABLE vfs_dirents (
  parent_inode INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  child_inode  INTEGER NOT NULL,
  PRIMARY KEY (parent_inode, name)
);
CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode);
```

Path resolution walks `vfs_dirents` from the root inode (`inode = 1`,
created on init). For typical agent trees (<10 deep) this is
sub-millisecond. Rename is one `UPDATE`; hardlinks are two dirents
pointing at the same inode.

### `vfs_blobs` — content-addressed chunk metadata

```sql
CREATE TABLE vfs_blobs (
  hash      BLOB    PRIMARY KEY,   -- 32 bytes, sha256(bytes)
  size      INTEGER NOT NULL,       -- length(bytes)
  last_seen INTEGER NOT NULL        -- ms since epoch; touched on every ref (GC clock)
);
```

### `vfs_blob_bytes` — chunk bytes

```sql
CREATE TABLE vfs_blob_bytes (
  hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
  bytes BLOB NOT NULL
);
```

Metadata and bytes live in separate tables so GC-clock updates to
`last_seen` don't rewrite the SQLite pages holding the (potentially
large) `bytes` BLOB. Hot blobs get their small fixed-size row touched
on every reference; the byte pages stay cold.

Every file chunk and every manifest is stored here, keyed by sha256.
Identical bytes anywhere in the tree share one row.

### `vfs_chunks` — file content mapping

```sql
CREATE TABLE vfs_chunks (
  inode INTEGER NOT NULL,
  idx   INTEGER NOT NULL,           -- chunk index inside the file (0-based)
  hash  BLOB    NOT NULL,           -- references vfs_blobs.hash
  size  INTEGER NOT NULL,           -- denormalized for fast stat()/SUM()
  PRIMARY KEY (inode, idx)
);
CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash);
```

Files are split into chunks of at most `CHUNK_SIZE` (512 KiB). Each
chunk is one row pointing at the underlying blob. The by-hash index
lets the manifest pull resolve "which inodes share this blob" quickly.

### `vfs_manifests` — chunk-list lookup

```sql
CREATE TABLE vfs_manifests (
  hash      BLOB    PRIMARY KEY,             -- sha256(encoded)
  size      INTEGER NOT NULL,                -- total file size in bytes
  encoded   BLOB    NOT NULL,                -- ordered chunk list (see below)
  last_seen INTEGER NOT NULL DEFAULT 0       -- ms since epoch; touched on every ref (GC clock)
);
```

A manifest is the ordered `(chunk hash, size)` list for one file. Files
with identical content share a manifest hash (and thus avoid being
re-uploaded over the sync wire). The `manifest_hash` column on
`vfs_nodes` points here.

`last_seen` is the manifest-side mirror of `vfs_blobs.last_seen`:
`buildManifest()` refreshes it on every reference, and `gc()` uses it
to sweep manifests with `last_seen < cutoff`. Storing it on
`vfs_manifests` itself (rather than only on the referenced blob)
matters because a manifest is also a blob, and the GC scan over
manifests needs the clock directly addressable.

**Encoding.** `encoded` is JSON today:

```json
{ "version": 1, "chunks": [{ "hash": "<hex>", "size": <n> }, ...] }
```

The planned phase-4 swap is the casync `.caidx` byte layout
(`0x01 || repeated (32-byte hash || varint size)`), readable and
debuggable in the JSON form first, then re-encoded for size. The
swap is a behaviour change inside `buildManifest()` / `parseManifest()`
— no schema change. One open question: the original sketch included a
`varint offset` per chunk, but offsets are recoverable from a prefix
sum of `size`, so the byte layout most likely should drop it.
Resolve before the encoding swap lands.

### `vfs_changes` — tombstones

```sql
CREATE TABLE vfs_changes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  rev  INTEGER NOT NULL,
  path TEXT    NOT NULL,
  op   TEXT    NOT NULL CHECK(op IN ('delete'))
);
CREATE INDEX vfs_changes_by_rev ON vfs_changes(rev);
```

Deletes leave no row in `vfs_nodes`, so they're recorded here for
the incremental push to tell the container "this path is gone". A
single mutation (e.g. `rm -r`) records one tombstone per removed
path, all sharing the same `rev` — the bumped value at delete time.

**Pruning** *(planned; not yet wired)*. The target behaviour is to
delete rows with `rev <= pushRev` in the same transaction that
advances `pushRev` (see
[02. Sync Protocol](./02_sync_protocol.md#watermarks)) — the container
has acknowledged them, no future pull needs to replay them. Today
`writeWatermark` only updates `_vfs_watermark`; there is no
`DELETE FROM vfs_changes` anywhere in the package, so the table grows
unboundedly with delete activity. Cheap to add once the apply path
becomes push-atomic.

### `_vfs_watermark` — sync state

```sql
CREATE TABLE _vfs_watermark (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
```

Stores `pushRev` and `fetchRev` (see
[02. Sync Protocol](./02_sync_protocol.md#watermarks)). Survives DO
restarts so reconnects resume cleanly.

### `_vfs_fetch_cursor` — fetch path tie-breaker

```sql
CREATE TABLE _vfs_fetch_cursor (
  k    TEXT PRIMARY KEY CHECK(k = 'fetch'),
  path TEXT
);
```

Stores the path component for the fetch cursor. The numeric rev remains
in `_vfs_watermark.fetchRev`; `path = NULL` means every change committed
at or before that rev has been offered to the receiver, and a non-null
`path` resumes within `fetchRev`. The cursor is a resume point, not a
point-in-time snapshot: a path rewritten after a fetch opens is deferred
to a later cursor rather than frozen at `fetchRev`. See
[02. Sync Protocol](./02_sync_protocol.md) for the full contract.

### `_vfs_mounts` — mount index state

```sql
CREATE TABLE _vfs_mounts (
  root    TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0
);
```

*Planned; mount feature not yet implemented — see
[06. Mount Interface](./06_mount_interface.md).* The schema seat is
in place so the migration doesn't need to land alongside the mount
runtime, but no code reads or writes this table yet. When mounts
ship, the row will record that a mount root has been indexed (its
directory tree listed and stub rows inserted into `vfs_nodes`) so a
DO reload doesn't re-list.

## Invariants

- The root directory is always `inode = 1`, type `dir`, with no
  parent dirent.
- A `vfs_nodes` row with `type = 'file'` is in one of two shapes:
  - **lazy stub**: `stub_size NOT NULL`, no `vfs_chunks` rows. The
    first read fetches the bytes and migrates the row to the
    committed shape.
  - **committed file**: zero or more `vfs_chunks` rows (one per
    chunk; an empty file has zero). `manifest_hash` is optional.
    When set, a matching `vfs_manifests` row lists the same chunk
    hashes and lets sync skip the per-chunk fetch on receivers
    that already have the manifest. When `NULL`, sync walks
    `vfs_chunks` directly. The buffered-write path commits chunks
    with `manifest_hash = NULL`; the legacy whole-file
    `writeFileSync` path stamps a manifest.
- For every file row, `vfs_nodes.size = COALESCE(SUM(vfs_chunks.size), 0)`
  over its `vfs_chunks` rows. Every write path stamps the column
  in the same `UPDATE` that bumps `mode`/`mtime`/`rev`, so `stat`,
  `lstat`, and `readRangeSync` can read it directly instead of
  running the aggregate.
- Every `vfs_chunks.hash` references an existing `vfs_blobs.hash`.
- Every `vfs_blobs.hash` has a matching `vfs_blob_bytes` row.
- Every `vfs_manifests.hash` referenced by
  `vfs_nodes.manifest_hash` exists.
- Every `vfs_dirents.child_inode` references an existing
  `vfs_nodes.inode`.
- The singleton `rev` in `vfs_meta` is strictly greater than every
  `vfs_nodes.rev` and every `vfs_changes.rev` between
  transactions.

## Garbage collection

GC is exposed as a free function from the package's internal `fs/gc.ts`
module, not as a method on the host workspace class:

```ts
import { gc } from "./fs/gc";

const { manifestsFreed, blobsFreed } = gc(db, {
  now: () => Date.now(),       // optional, injectable for tests
  safetyWindowMs: 60_000,      // optional; conservative default
});
```

It sweeps `vfs_blobs` and `vfs_manifests` for rows with no live
references and a `last_seen` older than the safety window. Cascaded
`vfs_blob_bytes` rows are deleted with their parent blob. Returns
`{ manifestsFreed, blobsFreed }`.

Maintainer decision: `gc()` stays internal for now. There is no
`Workspace.gc()` on the public surface — agents don't drive collection
directly, and the function shape (with an injectable `now`) is chosen
for testability rather than as a public API. Revisit if a real caller
needs to trigger collection explicitly.

## Symlinks

The schema seats for symlinks are already shipped: `vfs_nodes.type`
accepts `'symlink'`, and `vfs_nodes.link_target TEXT` carries the
link's target string. FS-layer support exists too — `fs/symlink.ts`
and `fs/readlink.ts` implement the primitives, and `fs/resolve.ts`
enforces an `ELOOP` cap during path resolution.

Maintainer decision: symlinks stay an **internal-only** primitive,
used by the `node:vfs` adapter to back constructs like `pnpm`'s
`node_modules` layout or `node_modules/.bin`. They are not exposed
on `WorkspaceFilesystem`; agent-facing code calling
`workspace.fs.symlink(...)` or `workspace.fs.readlink(...)` is not
supported, and the surface intentionally stops at file/dir
operations. See doc 04 for the rationale.

## Future considerations

Items deferred from the initial design. File an issue if a real use
case depends on a particular resolution.

### Tier large blobs to R2

All bytes currently live in DO SQLite. The advertised cap is ~10 GB
shared with the host DO, which is sufficient for agent-scale
workspaces. If a single workspace needs to hold large datasets
(parquet, sqlite databases, model weights, video), an optional R2
binding could write blobs over a configurable threshold (default
4 MiB) to R2 keyed by `hex(hash)`. Small/hot content stays in
`vfs_blob_bytes`.

Sketch:

```sql
ALTER TABLE vfs_blobs ADD COLUMN location TEXT NOT NULL DEFAULT 'sqlite';
-- 'sqlite' | 'r2'
```

Reads check `location` and dispatch. Adds a network hop on cold reads
of large blobs; agent workloads rarely re-read large blobs.

### Content-defined chunking

Today files are split at fixed 512 KiB boundaries. That works well for
append-mostly or tail-edit patterns: rewriting the last chunk of a
large file pulls back only the affected chunk, and dedup catches
identical content at identical offsets.

It loses dedup when bytes are **inserted near the head** of a large
file. Because the boundaries are at fixed multiples of 512 KiB, an
inserted byte at offset 0 shifts every subsequent boundary by one — so
every later chunk has new bytes at its boundaries and a different
sha256, even though 99% of the file is unchanged. The DO has to
re-fetch every chunk.

**Worked example.** A 50 MB file gets one new line prepended:

| Scheme | What changes on the wire |
| --- | --- |
| Fixed 512 KiB | All 100 chunks have new hashes; full re-fetch. |
| Content-defined (e.g. FastCDC) | One or two chunks near the head change; the rest still match because their boundaries are picked by content. |

**How CDC picks boundaries.** Rather than `every 512 KiB`, a rolling
hash (FastCDC, Rabin) slides byte-by-byte over the file and declares a
boundary whenever the hash matches a target pattern. Because the
pattern depends on the surrounding bytes — not the absolute offset —
inserting a byte at the head only disturbs the first chunk that
contained the insertion point. Every later boundary still lands at the
same byte-pattern it did before, so those chunks keep their hashes and
dedup catches them.

The cost is CPU per write (the rolling hash) and slight variability in
chunk size. Defaults stay fixed-size for simplicity; CDC would be
opt-in per mount or above a file-size threshold:

```ts
new Workspace({
  chunking: { strategy: "fastcdc", minSize: 256 << 10, maxSize: 1 << 20 },
});
```

Switching strategies is safe at the data layer: `(hash, size)` pairs
still uniquely identify a chunk; the manifest format does not change.
Files written under different strategies just don't share chunks with
each other, which is the same behaviour as files written with
different fixed chunk sizes today.

### Extended attributes

The schema has no place to hang per-inode metadata beyond `mode` and
`mtime`. Real tooling occasionally leans on xattrs: `setcap`, macOS
quarantine flags, some language toolchains. A future iteration would
add a separate `vfs_xattrs(inode, key, value)` table. Additive; not
required for the initial agent workloads.

### Prior art and selective reuse

Several projects already represent a POSIX-like filesystem in SQLite.
Two are worth comparing against directly:

- **`narumatt/sqlitefs`** — a Rust FUSE driver backing a SQLite
  database. Schema is `metadata` + `data` + `dentry` + `xattr`, with
  inode-keyed metadata and `(file_id, block_num)` chunk rows. POSIX-
  complete (hardlinks, symlinks, xattrs, ACLs). Implementation is
  Rust-only, not a published spec; the schema is internal to the
  project.
- **Turso `tursodatabase/agentfs`** — a *published specification*
  (`SPEC.md`, currently v0.4) for an agent-oriented SQLite
  filesystem, with SDKs in TypeScript, Python, and Rust. The
  filesystem half of the spec uses `fs_inode` + `fs_dentry` +
  `fs_data` + `fs_symlink` + `fs_config`, plus optional
  `fs_whiteout` / `fs_origin` for overlay/copy-on-write semantics.
  Nanosecond-precision timestamps, full POSIX mode bits including
  special-file types, hardlinks via `nlink` and multiple dentries.

**Shape comparison.** AgentFS is the closer analogue and the more
interesting one because it ships a real spec we could implement
against. Mapping our tables onto AgentFS:

| AgentFS | Ours | Notes |
| --- | --- | --- |
| `fs_inode` | `vfs_nodes` | Same role. AgentFS carries `nlink`, `uid`/`gid`, `rdev`, separate `atime`/`mtime`/`ctime` with `_nsec` columns. We carry `mtime` only plus content-sync columns (`rev`, `mount_root`, `stub_size`, `manifest_hash`). |
| `fs_dentry` | `vfs_dirents` | Same role. AgentFS adds a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT`; we use the composite `(parent_inode, name)` directly. |
| `fs_data` | `vfs_chunks` + `vfs_blobs` + `vfs_blob_bytes` | **Fundamental divergence.** AgentFS stores chunks as `(ino, chunk_index)` rows with the bytes inline — no content addressing, no dedup. Our split into hash-keyed blob metadata, blob bytes, and an `inode`-keyed chunk map is what makes the sync protocol's incremental transfer work. |
| `fs_symlink` | `vfs_nodes.link_target` | We inline the target on the inode row rather than a side table; the data is the same. |
| `fs_config` | `vfs_meta` | Same role. |
| `fs_whiteout`, `fs_origin` | (no equivalent) | Overlay/COW semantics. Not needed today; potentially interesting if read-only mount overlays grow up. |
| (no equivalent) | `vfs_manifests` | Content-addressed per-file chunk list; required by our sync protocol. |
| (no equivalent) | `vfs_changes` | Tombstones for incremental push; required by our sync protocol. |
| (no equivalent) | `_vfs_watermark`, `_vfs_mounts` | Sync and mount bookkeeping. |

**Why not adopt AgentFS as the schema.** The blocker is the data
table. AgentFS keys chunks by `(ino, chunk_index)` with raw bytes
inline; we key chunks by `sha256(bytes)` and dereference through a
manifest. The two are not slot-in compatible — our sync protocol
(`02_sync_protocol.md`) is *built* on hash-addressed chunk dedup and
manifest sharing across paths, both of which AgentFS explicitly does
not provide. AgentFS could in principle add content addressing as an
extension, but at that point we are extending the spec, not
consuming it.

Their non-filesystem tables (`tool_calls`, `kv_store`) and the
overlay-COW tables (`fs_whiteout`, `fs_origin`) solve different
problems than ours and don't fit our domain.

**Where to spend the reuse budget**

Two concrete borrows, no runtime dependency:

1. **Adopt AgentFS metadata fields where they cleanly map.** When
   xattrs land, use their pattern. When nanosecond timestamps matter,
   mirror `*_nsec` columns rather than inventing our own encoding.
   POSIX `mode` bit semantics, `nlink`, `uid`/`gid`/`rdev`: align with
   their definitions even if we don't surface every field today.
2. **Document the divergence and the integration path.** A
   `vfs_*` workspace lives happily alongside an AgentFS database
   in the same DO storage (different prefixes), so an agent could
   use AgentFS for tool-call audit + KV state and our workspace for
   the synced FUSE-mounted file tree. Worth saying explicitly so
   nobody assumes the two compete.

**Where to *not* spend it**

- Don't replace our chunk store with `fs_data`. We lose every dedup
  win and break the sync protocol.
- Don't pull in `agentfs-sdk` as a runtime dep. The DO already talks
  to SQLite directly; a host-side SDK adds an indirection without
  giving us anything we don't have.
- Don't adopt `sqlitefs`'s schema. It's an implementation, not a
  spec, and the FUSE-on-host model is the opposite of our DO-side-
  truth model.

**If AgentFS ever publishes a content-addressed extension** to the
data table, revisit this decision. The metadata-side alignment we've
described above would make adopting it a small change.
