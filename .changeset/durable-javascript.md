---
"@cloudflare/computer": minor
---

Add experimental `onInterrupt: "restart" | "replay"` to `WorkerJavaScriptBackend`, so runs interrupted by a deploy or crash can resume. Also adds `runtime.recover()`, `unsafeToRepeat()` and `callId` on host module call contexts.
