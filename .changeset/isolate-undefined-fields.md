---
"@cloudflare/computer": patch
---

The JavaScriptWorkerBackend now strips non-serializable return values matching JSON.stringify(); see [isolate JavaScript documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#isolate-javascript-runtime).
