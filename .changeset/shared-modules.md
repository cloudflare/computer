---
"@cloudflare/computer": patch
---

Each `JavaScriptWorkerBackend` now only stores each module once, so a large bundle counts once; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules).
