# @cloudflare/computer

## 0.2.0

### Minor Changes

- [#88](https://github.com/cloudflare/computer/pull/88) [`9ecb912`](https://github.com/cloudflare/computer/commit/9ecb912bbf0cfc17e48e8963d4ae104d4b404be9) Thanks [@aron-cf](https://github.com/aron-cf)! - Configure ambient network access consistently across execution backends.

- [`2bfce96`](https://github.com/cloudflare/computer/commit/2bfce96829dbb8045733d130016b7d60f60abe0e) Thanks [@aron-cf](https://github.com/aron-cf)! - Expose bounded workspace byte reads through RPC and return paginated directory listings with file metadata.

- [`19a65bc`](https://github.com/cloudflare/computer/commit/19a65bce35ac352a73ebbb19d9ee3b89851928eb) Thanks [@aron-cf](https://github.com/aron-cf)! - Add line formatting and byte continuations to `read`, with bounded image and PDF model output.

- [`f673226`](https://github.com/cloudflare/computer/commit/f6732261d639b34a07f836672e54a374afa34b89) Thanks [@aron-cf](https://github.com/aron-cf)! - Add bounded `find` and `grep` tools, a read-only-aware `delete` tool, and shared locking for file mutations.

- [#41](https://github.com/cloudflare/computer/pull/41) [`a753db7`](https://github.com/cloudflare/computer/commit/a753db7ead38a3028939a87ee9dc087da38d9928) Thanks [@aron-cf](https://github.com/aron-cf)! - Heavy worker-shell commands are now opt-in to reduce the final bundle size. See the [documentation](/docs/12_worker_backend.md) for details.

### Patch Changes

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
