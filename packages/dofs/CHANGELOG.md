# @cloudflare/dofs

## 0.7.1

### Patch Changes

- [#249](https://github.com/cloudflare/computer/pull/249) `SQLiteWorkspaceProvider.readdirEntriesSync(path)` lists a directory with each entry's type, permission bits and inode, as an `lstat` of it reports them, from one query. ([`07e3920`](https://github.com/cloudflare/computer/commit/07e39207465085ba7a98a6f8ed06b3ead4621cea)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.7.0

## 0.6.0

## 0.5.1

### Patch Changes

- [#214](https://github.com/cloudflare/computer/pull/214) `find` and `grep` globs match brace alternatives such as `**/*.{ts,tsx}`; see [`find` documentation](https://github.com/cloudflare/computer/blob/main/docs/04_filesystem_interface.md#find). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) An exclusion ending in `/**` also prunes the directory it names in `find` and `grep`; see [`find` documentation](https://github.com/cloudflare/computer/blob/main/docs/04_filesystem_interface.md#find). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#230](https://github.com/cloudflare/computer/pull/230) Deletes made in the container now reach the Durable Object, and pushed deletes reach computerd; see [replay and idempotency documentation](https://github.com/cloudflare/computer/blob/main/docs/02_sync_protocol.md#replay-and-idempotency). ([`b663993`](https://github.com/cloudflare/computer/commit/b66399391cbadf55308affc9ed3e6098ccc09a41)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#215](https://github.com/cloudflare/computer/pull/215) Mounts can now declare a `version` to support schema migrations; see [mount version documentation](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#versions). ([`50a80cc`](https://github.com/cloudflare/computer/commit/50a80cc3847f0b043df7750725d000a31de5147a)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.2

### Patch Changes

- [#150](https://github.com/cloudflare/computer/pull/150) Add an `exclude` option to `fs.grep`, matching `fs.find`. ([`e5e28a7`](https://github.com/cloudflare/computer/commit/e5e28a79d74f1e173006193bf3eeb0d990c98930)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.1

### Patch Changes

- [#146](https://github.com/cloudflare/computer/pull/146) Resolve sync change paths in batches and index tombstone scans by `(op, rev)`. ([`7ce8259`](https://github.com/cloudflare/computer/commit/7ce8259324d40d32e7b2db9d371ea5b19f4c8f63)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) Extend `Workspace.fs` to include `rename(oldPath, newPath)`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) `find` now accepts `exclude` e.g. `ws.fs.find("/workspace", "**/*.ts", { exclude: ["node_modules/**"], })`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) `mkdir` now follows symbolic links in intermediate path segments. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#123](https://github.com/cloudflare/computer/pull/123) Support `computerd` persisting its workspace to disk instead via `COMPUTERD_DB=<path>` — see [the `computerd` README](../packages/computerd/README.md#on-disk-store). ([`ef8cd11`](https://github.com/cloudflare/computer/commit/ef8cd11040b222875f1d04e7cfd6553068e07bb7)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.0

## 0.2.1

## 0.2.0

### Minor Changes

- [`eda0ddc`](https://github.com/cloudflare/computer/commit/eda0ddc3769fe59eec0b64dc8cb163af54ae869e) Thanks [@aron-cf](https://github.com/aron-cf)! - Add stable directory pagination with metadata, bounded byte reads, single-character globs, and configurable bounded grep results.

### Patch Changes

- [#93](https://github.com/cloudflare/computer/pull/93) [`adbf497`](https://github.com/cloudflare/computer/commit/adbf4978e14769a7bb452d692260c76032ec42b8) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix symlink path resolution and write behavior. Relative symlink targets now resolve from the symlink parent, writes follow symlinked parent directories, and writes to final symlinks update or create the target file instead of storing chunks on the symlink node.

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
