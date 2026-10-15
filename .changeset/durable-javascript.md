---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` can restart or replay runs interrupted by a deploy or crash, with the `onInterrupt` option and `runtime.recover()`. Host module functions can opt out of running twice with `unsafeToRepeat()`.
