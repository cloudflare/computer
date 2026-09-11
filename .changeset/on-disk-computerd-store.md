---
"@cloudflare/dofs": minor
---

Let `computerd` keep its workspace on disk instead of in memory, so it survives a restart. Set `COMPUTERD_DB` to a file path — see [the `computerd` README](../packages/computerd/README.md#on-disk-store).
