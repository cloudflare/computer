---
"@cloudflare/computer": minor
---

`runtime.exec()` takes `metadata`, a record of strings for host modules that the run's code never sees. Host module calls read it as `context.execution.metadata`, `runtime.pending()` lists it with each waiting call, and a replayable run keeps it when it resumes. `WorkerJavaScriptBackend` caps it at 16 KiB of keys and values.
