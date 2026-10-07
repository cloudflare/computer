---
"@cloudflare/computer": patch
---

A cyclic argument to a `node:fs` or host module call fails with a "must be acyclic" error; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention).
