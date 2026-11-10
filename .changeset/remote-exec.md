---
"@cloudflare/computer": minor
---

Add `@cloudflare/computer/remote-exec`, an experimental `codemode:exec` module whose `exec()` runs a command in a container Durable Object, with Workspace files pushed in and pulled back, and returns a process shaped like `ctx.container.exec()`'s, and the `ghcr.io/cloudflare/computer-remote-exec` image with its `remote-exec` binary. See [Remote exec](https://github.com/cloudflare/computer/blob/main/docs/20_remote_exec.md).
