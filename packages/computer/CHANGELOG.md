# @cloudflare/computer

## 0.3.0

### Minor Changes

- [#110](https://github.com/cloudflare/computer/pull/110) [`c85a255`](https://github.com/cloudflare/computer/commit/c85a25597ab9c28c8f50245f6ec24d76532794df) Thanks [@aron-cf](https://github.com/aron-cf)! - The container's HTTP surface now requires a bearer token. The host generates a secret, passes it to the container as RPC_CLIENT_SECRET at launch, and sends it on /connect. Readiness at /health stays open, and leaving the variable unset disables the checks. Before opening a session the host checks that the container refuses an unauthenticated request and fails the connect if it does not, so a container or image predating this has to be recycled. The container's dial-back to the host carries the same secret, and the host refuses an upgrade that does not present it.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The /connect caller now provides both API & healthcheck endpoints. The container no longer builds either path itself, so a host is free to serve them wherever it likes.

- [#110](https://github.com/cloudflare/computer/pull/110) [`199fc17`](https://github.com/cloudflare/computer/commit/199fc1740b019cae0274b810d99861b093e2a3e4) Thanks [@aron-cf](https://github.com/aron-cf)! - `IWorkspaceContainerAPI.start()` and `restart()` now take a single `ContainerLaunchSpec` of `{ env, enableInternet }` instead of two arguments, and return which of `launched`, `adopted` or `relaunched` happened. Each launch records its spec, and a container found already running is relaunched unless it matches, because neither the environment nor the internet flag can be changed on a live container. A container started outside this API has no record and is relaunched rather than trusted. `setInactivityTimeout()` joins the interface so a caller that pre-starts containers, such as a warm pool, does not need to reach past it.

- [#110](https://github.com/cloudflare/computer/pull/110) [`c85a255`](https://github.com/cloudflare/computer/commit/c85a25597ab9c28c8f50245f6ec24d76532794df) Thanks [@aron-cf](https://github.com/aron-cf)! - A command run through the shell no longer inherits the container's whole environment. It receives PATH, HOME, TMPDIR, TZ, LANG, TERM, the LC* family, and any variable prefixed COMPUTER_VAR*, which arrives with the prefix stripped so COMPUTER_VAR_NODE_ENV becomes NODE_ENV. A workspace that relied on some other inherited variable needs the prefix.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The UPSTREAM_URL environment variable has been removed along with the container's own sync loop. Syncing is driven by whichever peer holds the other end of the Cap'n Web session.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The Cap'n Web /ws endpoint has been renamed to /api at both ends of the connection. A durable object that routes the container's outbound upgrade must match /api in its own fetch handler. Support for the Cap'n Web HTTP batch transport has been removed, so /api carries a websocket only.

- [#109](https://github.com/cloudflare/computer/pull/109) [`e2dd6d8`](https://github.com/cloudflare/computer/commit/e2dd6d8f9a5d078024cad52fff179bbb33fc3597) Thanks [@aron-cf](https://github.com/aron-cf)! - Make the artifacts session id optional: `createArtifact(binding)` now returns a client over the whole namespace rather than requiring a session to scope by. See [./docs/15_artifacts_interface.md](./docs/15_artifacts_interface.md) for details.

### Patch Changes

- [#111](https://github.com/cloudflare/computer/pull/111) [`e9bbc50`](https://github.com/cloudflare/computer/commit/e9bbc50103c7eeea258b83faf3049d64830bc037) Thanks [@aron-cf](https://github.com/aron-cf)! - Create missing parent directories while applying sync entries.

- [#96](https://github.com/cloudflare/computer/pull/96) [`45fa716`](https://github.com/cloudflare/computer/commit/45fa7163563f3f5ddb8398aece6f6ed64be58ed9) Thanks [@agent-think](https://github.com/apps/agent-think)! - Fix issue where the edit tool would rewrite the whole file when oldText doesn't match exactly.

- [#113](https://github.com/cloudflare/computer/pull/113) [`f35f5df`](https://github.com/cloudflare/computer/commit/f35f5dfd06d57f801414a3a0583669267f092ed9) Thanks [@aron-cf](https://github.com/aron-cf)! - Sync `node_modules` by default so package manager installs persist across workspace runtimes.

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
