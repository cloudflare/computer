# @cloudflare/dofs

## 0.4.0

### Minor Changes

- [#124](https://github.com/cloudflare/computer/pull/124) `Workspace.fs` gains `rename(oldPath, newPath)`, exposing the store's existing transactional move through the public surface and through `WorkspaceFilesystemStub`. An existing destination is replaced when the two ends agree on kind — a file or symbolic link for a file or symbolic link, an empty directory for a directory — and the operation reports `ENOENT`, `ENOTEMPTY`, `EISDIR`, `ENOTDIR`, `EINVAL`, and `EROFS` as documented in `docs/04_filesystem_interface.md`. The Worker shell's `mv` now calls it, so an interrupted move no longer leaves the entry at both paths or a directory half copied. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) `find` accepts `exclude`, a list of glob patterns matched against the same directory-relative path as the inclusion glob. Exclusion is decided first, so it always wins, and an excluded directory is pruned during traversal: neither it nor anything below it is read. `limit` and `offset` apply to the matches that survive. The option travels through `WorkspaceFilesystem`, `WorkspaceFilesystemStub`, and the public find tool. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

  ```ts
  const sources = await workspace.fs.find("/workspace", "**/*.ts", {
    exclude: ["node_modules", "node_modules/**", ".git", ".git/**"],
  });
  ```

- [#123](https://github.com/cloudflare/computer/pull/123) Let `computerd` keep its workspace on disk instead of in memory, so it survives a restart. Set `COMPUTERD_DB` to a file path — see [the `computerd` README](../packages/computerd/README.md#on-disk-store). ([`ef8cd11`](https://github.com/cloudflare/computer/commit/ef8cd11040b222875f1d04e7cfd6553068e07bb7)) - Thanks [@aron-cf](https://github.com/aron-cf)

### Patch Changes

- [#124](https://github.com/cloudflare/computer/pull/124) `mkdir` now follows symbolic links in intermediate path segments, so a link to a directory resolves transparently instead of failing with `ENOTDIR`. Creating `/alias/new-directory` where `/alias` points at `/real` creates `/real/new-directory`, and recursive creation places its missing ancestors under the resolved parent. A resolved parent that is a file still reports `ENOTDIR`, a dangling parent link reports `ENOENT`, and a chain longer than the shared forty-hop budget reports `ELOOP`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.0

## 0.2.1

## 0.2.0

### Minor Changes

- [`eda0ddc`](https://github.com/cloudflare/computer/commit/eda0ddc3769fe59eec0b64dc8cb163af54ae869e) Thanks [@aron-cf](https://github.com/aron-cf)! - Add stable directory pagination with metadata, bounded byte reads, single-character globs, and configurable bounded grep results.

### Patch Changes

- [#93](https://github.com/cloudflare/computer/pull/93) [`adbf497`](https://github.com/cloudflare/computer/commit/adbf4978e14769a7bb452d692260c76032ec42b8) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix symlink path resolution and write behavior. Relative symlink targets now resolve from the symlink parent, writes follow symlinked parent directories, and writes to final symlinks update or create the target file instead of storing chunks on the symlink node.

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
