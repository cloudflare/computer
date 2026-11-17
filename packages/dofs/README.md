# `@cloudflare/dofs`

> [!NOTE]
> **Stable**, meaning suitable for production use, except the sync
> protocol building blocks, which serve the experimental sync with
> `computerd` and share its status. This package is not
> published to npm on its own: it ships bundled inside
> [`@cloudflare/computer`](../computer/README.md), which re-exports the
> parts meant for callers. See that package's
> [status table](../computer/README.md#status) for which components of
> Cloudflare Computer are stable and which are experimental.
>
> The specification under [`docs/`](../../docs/README.md) is forward-looking — read it for
> intent, not as description of the code today.

Durable Object SQLite-backed virtual filesystem for Cloudflare Computer.

This package exposes a JavaScript module, not a CLI. It bundles three layers that can be used independently:

- A `Database` wrapper around Durable Object SQL storage plus `initializeSchema` for the `vfs_*` tables.
- Filesystem primitives under `src/fs/*` (`mkdir`, `writeFile`, `readFile`, `rm`, `rename`, `readdir`, `stat`, `lstat`, `chmod`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) operating on a `Database`.
- `SQLiteWorkspaceProvider`, a `@platformatic/vfs` adapter that composes those primitives into a node-shaped filesystem (fd table, positional `readSync`/`writeSync`, `watchSync`, symlinks). This is what `computerd` mounts via FUSE.
- Sync protocol building blocks operating on the same `Database`: `applyChanges`, `stageBlob`, `materialiseChange`, `coalesceChanges`, `fetchChanges`, `fetchObjects`, `hasObjects`, `pushObjects`, `buildManifest`, `currentRev`, `compareChangeCursors`, `readWatermark`/`writeWatermark`, `assertAppliedPushCursor`, and the opt-in ignore matcher `isIgnored` (the default ignore list is empty). The wire wiring lives in `@cloudflare/computer-rpc`.

Minimal DO-side usage — initialize the schema; the `Database` becomes the handle every other helper takes:

```ts
import { Database, initializeSchema } from "@cloudflare/dofs";

export class WorkspaceDO extends DurableObject {
  private readonly db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Database(ctx.storage);
    initializeSchema(this.db, Date.now);
  }
}
```

> The `src/fs/*` primitives (`mkdir`, `writeFile`, `readFile`, `rm`, `readdir`, `stat`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) are not re-exported from the package root yet — they are consumed in-tree by `SQLiteWorkspaceProvider` and by the sync `applyChanges` path. On the node side, instantiate `SQLiteWorkspaceProvider` (the `@platformatic/vfs` adapter) for a familiar node:fs-shaped surface; this is what `@cloudflare/computerd` mounts via FUSE. The higher-level durable-object-side `Workspace` class described in [`../../docs/README.md`](../../docs/README.md) lives in [`@cloudflare/computer`](../computer/README.md).

## Implementation status


- `Database` wrapper around Durable Object SQL storage in place.
- Schema initialization for the documented `vfs_*` tables (FS and sync) implemented and split into `schema/core.ts` + `schema/sync.ts`.
- `incrementRev()` shared sequencer in place. FS writes stamp the returned value into `vfs_nodes.rev` and pass it to `sync/changes.ts` for tombstones.
- `SQLiteTestStorage` (backed by `node:sqlite`) available from `./testing` for unit tests against a real in-memory database; `RecordingStorage` available from the package root for workerd-safe schema assertions.
- All filesystem primitives listed above are implemented and unit-tested.
  `readdir` returns size and modification time and supports stable
  `limit`/`offset` pages, including files held in pending write buffers.
  `find` supports `*`, `**`, and `?` globs. `grep` supports bounded pages,
  regular expressions or fixed strings, explicit case handling, and numbered
  context lines.
- `SQLiteWorkspaceProvider` (the `@platformatic/vfs` adapter) implemented and exported from the package entrypoint; consumed by `@cloudflare/computerd`.
- Buffered-write surface for the FUSE driver: `createFileSync`,
  `writeRangeSync`, `truncateFileSync`, `readRangeSync`, `chmodSync`,
  `openWriteBufferSync`, `openWriteBufferForCreateSync`, and
  `releaseWriteBufferSync` on the provider. The driver opens a buffer
  on FUSE create/open, mutates it through subsequent writes and
  truncates, and commits chunks in one transaction at release time.
  Reads against the same database see the buffered bytes immediately.
- Content-addressed blob cache: `readFile`, `readRangeSync`,
  `provider.readFileSync`, and the partial-chunk read-modify-write
  helper share a per-`Database` LRU keyed by `vfs_blob_bytes.hash`.
  Repeated reads of dedup'd chunks (a file of zeroes, a re-used
  package payload) skip SQLite after the first fetch.
- Sync protocol building blocks implemented and exported; the typed RPC surface on top of them lives in `@cloudflare/computer-rpc`.
- Storage follows live data. dofs reaps content, deleting a chunk blob or manifest row nothing references any more, in the write that drops its last reference: an overwrite, truncate, range write, buffer release, `rm`, a rename over a file, or a sync apply. Content another file or hardlink still uses stays. Code that holds a hash across an await pins it in memory so it is not reaped under it: lazy `readFile` streams (released when they end, or after five idle minutes), streaming `writeFile`, the push sender (`pinObjects`), and hashes `hasObjects` reported present (for ten minutes). Each sync apply call holds what its own entries drop until it ends, so a rename that arrives as a delete and a new file still finds its content. An incremental sweep, eight rows and at most 512 KiB per write, reaps what is left once its `last_seen` (the wall-clock time dofs last wrote or staged it) is an hour old: staging nothing linked, deferrals a restart lost, and the backlog in stores written before reaping. See [`docs/03_filesystem_schema.md`](../../docs/03_filesystem_schema.md#garbage-collection).

  Pins live on the `Database` object, so every caller that reads, writes or syncs one store has to share one `Database` handle, as the `Workspace` Durable Object and `computerd` do. A second handle on the same storage would not see the first one's pins.
