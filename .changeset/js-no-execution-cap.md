---
"@cloudflare/computer": minor
---

Remove `WorkerJavaScriptBackend`'s `maxConcurrentExecutions` option, leaving the platform's own limit on concurrent Dynamic Workers; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention).
