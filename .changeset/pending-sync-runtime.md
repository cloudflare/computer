---
"@cloudflare/computer": patch
---

`pull()` rejects with `ESYNC_LOST` when a pending command sync's container was replaced, and doesn't report complete until every pending command's changes are pulled. See [Command synchronization](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#command-synchronization).
