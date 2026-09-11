---
"@cloudflare/computer": minor
---

`Workspace.pull()` and `Workspace.push()` are now async iterables that commit one block of changes per iteration. This allows a caller to implement a deferred post-exec sync across several invocations. See [./docs/02_sync_protocol.md](./docs/02_sync_protocol.md) for details.
