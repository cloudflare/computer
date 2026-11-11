---
"@cloudflare/computer": patch
---

`pull()` now rejects with `ESYNC_LOST` when a pending command sync's container was replaced, and no longer reports complete before every pending command's changes are pulled.
