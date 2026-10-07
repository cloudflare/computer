---
"@cloudflare/computer": patch
---

`JavaScriptWorkerBackend` now uses native RPC for `modules` bindings; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention).
