---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` no longer caps concurrent executions, and the `maxConcurrentExecutions` option is removed. Its default of 24 sat above the platform's own limit of 10 concurrent Dynamic Workers per request, so runs 11 through 24 were admitted and then failed with a platform error anyway. Executions now start until the platform says no, and that error is the execution's error. Remove `maxConcurrentExecutions` from backend options.
