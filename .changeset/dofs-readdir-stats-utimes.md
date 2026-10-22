---
"@cloudflare/computer": patch
---

Add `readdirStatsSync` and `utimesSync` to `SQLiteWorkspaceProvider`, and keep a `chmod` made while a write buffer is open. See the [dofs README](https://github.com/cloudflare/computer/blob/main/packages/dofs/README.md).
