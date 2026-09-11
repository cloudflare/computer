# @cloudflare/computerd

## 0.4.0

### Minor Changes

- [#139](https://github.com/cloudflare/computer/pull/139) The exec runner now takes an optional shell naming the interpreter each command runs under, and computerd reads the same value from EXEC_SHELL. Both default to /bin/sh, so existing behavior is unchanged. On a Debian-family image /bin/sh is dash, where bash-only syntax such as the PIPESTATUS array is a parse error that aborts the command rather than a missing feature, and that array is how a caller recovers the real exit status of a pipeline whose output it filters. Repointing /bin/sh in the image was the only previous workaround, which changes echo semantics for every other script in that image and is unavailable when the image is prebuilt. ([`5f310b6`](https://github.com/cloudflare/computer/commit/5f310b69421d334dfd3791216ca0a6a704a36efa)) - Thanks [@aron-cf](https://github.com/aron-cf)

### Patch Changes

- Updated dependencies [[`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc), [`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc), [`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc), [`ef8cd11`](https://github.com/cloudflare/computer/commit/ef8cd11040b222875f1d04e7cfd6553068e07bb7)]:
  - @cloudflare/dofs@0.4.0
  - @cloudflare/computer-rpc@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies []:
  - @cloudflare/dofs@0.3.0
  - @cloudflare/computer-rpc@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @cloudflare/dofs@0.2.1
  - @cloudflare/computer-rpc@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [[`eda0ddc`](https://github.com/cloudflare/computer/commit/eda0ddc3769fe59eec0b64dc8cb163af54ae869e), [`adbf497`](https://github.com/cloudflare/computer/commit/adbf4978e14769a7bb452d692260c76032ec42b8), [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff), [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29)]:
  - @cloudflare/dofs@0.2.0
  - @cloudflare/computer-rpc@0.2.0
