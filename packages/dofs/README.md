# `@cloudflare/dofs`

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](../../docs/README.md) is forward-looking — read it for
> intent, not as description of the code today.

Durable Object SQLite-backed virtual filesystem for Cloudflare Computer.

This package exposes a JavaScript module, not a CLI. It bundles three layers that can be used independently:

- A `Database` wrapper around Durable Object SQL storage plus `initializeSchema` for the `vfs_*` tables.
- Filesystem primitives under `src/fs/*` (`mkdir`, `writeFile`, `readFile`, `rm`, `readdir`, `stat`, `lstat`, `chmod`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) operating on a `Database`.
- `SQLiteWorkspaceProvider`, a `@platformatic/vfs` adapter that composes those primitives into a node-shaped filesystem (fd table, positional `readSync`/`writeSync`, `watchSync`, symlinks). This is what `computerd` mounts via FUSE.
- Sync protocol building blocks operating on the same `Database`: `applyChanges`, `stageBlob`, `materialiseChange`, `coalesceChanges`, `fetchChanges`, `fetchObjects`, `hasObjects`, `pushObjects`, `buildManifest`, `currentRev`, `compareChangeCursors`, `readWatermark`/`writeWatermark`, `assertAppliedPushCursor`, and `DEFAULT_IGNORE`/`isIgnored`. The wire wiring lives in `@cloudflare/computer-rpc`.

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

> The `src/fs/*` primitives (`mkdir`, `writeFile`, `readFile`, `rm`, `readdir`, `stat`, `find`, `ls`, `grep`, `symlink`, `readlink`, `gc`, `watch`) are not re-exported from the package root yet — they are consumed in-tree by `SQLiteWorkspaceProvider` and by the sync `applyChanges` path. On the node side, instantiate `SQLiteWorkspaceProvider` (the `@platformatic/vfs` adapter) for a familiar node:fs-shaped surface; this is what `@cloudflare/computerd` mounts via FUSE. A higher-level DO-side `Workspace` class with the `fs`/`shell`/`push`/`pull` surface described in [`../../docs/README.md`](../../docs/README.md) is still future work.

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
- `WorkspaceFilesystem.readRange` exposes bounded byte reads without
  materializing the whole file.
- Content-addressed blob cache: `readFile`, `readRangeSync`,
  `provider.readFileSync`, and the partial-chunk read-modify-write
  helper share a per-`Database` LRU keyed by `vfs_blob_bytes.hash`.
  Repeated reads of dedup'd chunks (a file of zeroes, a re-used
  package payload) skip SQLite after the first fetch.
- Sync protocol building blocks implemented and exported; the typed RPC surface on top of them lives in `@cloudflare/computer-rpc`.
