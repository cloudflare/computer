---
"@cloudflare/computer": patch
---

`WorkerJavaScriptBackend` reads each host module's description whenever it describes itself, so a factory can describe something built later; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules).
