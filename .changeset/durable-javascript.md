---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` can restart or replay runs interrupted by a deploy or crash, with the experimental `onInterrupt` option and `runtime.recover()`. Host module functions can opt out of running twice with `unsafeToRepeat()`. Host module call contexts now carry a required `callId`.
