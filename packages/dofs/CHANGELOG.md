# @cloudflare/dofs

## 0.2.1

## 0.2.0

### Minor Changes

- [`eda0ddc`](https://github.com/cloudflare/computer/commit/eda0ddc3769fe59eec0b64dc8cb163af54ae869e) Thanks [@aron-cf](https://github.com/aron-cf)! - Add stable directory pagination with metadata, bounded byte reads, single-character globs, and configurable bounded grep results.

### Patch Changes

- [#93](https://github.com/cloudflare/computer/pull/93) [`adbf497`](https://github.com/cloudflare/computer/commit/adbf4978e14769a7bb452d692260c76032ec42b8) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix symlink path resolution and write behavior. Relative symlink targets now resolve from the symlink parent, writes follow symlinked parent directories, and writes to final symlinks update or create the target file instead of storing chunks on the symlink node.

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
