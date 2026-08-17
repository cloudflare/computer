# @cloudflare/computer

## 0.2.1

### Patch Changes

- [#102](https://github.com/cloudflare/computer/pull/102) [`e09135b`](https://github.com/cloudflare/computer/commit/e09135bbdbff4a50a487afae47be4ad3c31d1a60) Thanks [@agent-think](https://github.com/apps/agent-think)! - Embed the configured byte limit directly in Worker JavaScript capability size errors.

- [#95](https://github.com/cloudflare/computer/pull/95) [`1e6c027`](https://github.com/cloudflare/computer/commit/1e6c02791b6825ccdc743be17c402a4798ed7084) Thanks [@agent-think](https://github.com/apps/agent-think)! - Add support for short revision ids in the git module.

- [#103](https://github.com/cloudflare/computer/pull/103) [`8afbb7c`](https://github.com/cloudflare/computer/commit/8afbb7c340fb4ab08626cca576dba15eb7e7ed72) Thanks [@aron-cf](https://github.com/aron-cf)! - `container-shell` operations now reconnect after computerd restarts when retrying is safe, and process-local execution handles return `EEXEC_LOST` after container replacement. See [container connection recovery](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#command-synchronization).

## 0.2.0

### Minor Changes

- [#88](https://github.com/cloudflare/computer/pull/88) [`9ecb912`](https://github.com/cloudflare/computer/commit/9ecb912bbf0cfc17e48e8963d4ae104d4b404be9) Thanks [@aron-cf](https://github.com/aron-cf)! - Consolidate egress configuration across the existing backends. See [./examples/egress](./examples/egress) for details.

- [`2bfce96`](https://github.com/cloudflare/computer/commit/2bfce96829dbb8045733d130016b7d60f60abe0e) Thanks [@aron-cf](https://github.com/aron-cf)! - Expose bounded workspace byte reads through RPC and return paginated directory listings with file metadata.

- [`19a65bc`](https://github.com/cloudflare/computer/commit/19a65bce35ac352a73ebbb19d9ee3b89851928eb) Thanks [@aron-cf](https://github.com/aron-cf)! - Extend the `read` tool to support image and data formats.

- [`f673226`](https://github.com/cloudflare/computer/commit/f6732261d639b34a07f836672e54a374afa34b89) Thanks [@aron-cf](https://github.com/aron-cf)! - Updated `find` and `grep` tools to support additional filtering parameters, a `delete` tool.

- [#41](https://github.com/cloudflare/computer/pull/41) [`a753db7`](https://github.com/cloudflare/computer/commit/a753db7ead38a3028939a87ee9dc087da38d9928) Thanks [@aron-cf](https://github.com/aron-cf)! - Reduced the size of bundles using worker-shell by making many commands opt-in. See the [documentation](/docs/12_worker_backend.md) for details.

### Patch Changes

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
