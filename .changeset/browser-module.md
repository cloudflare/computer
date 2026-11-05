---
"@cloudflare/computer": minor
---

Add `createBrowserModule()` from `@cloudflare/computer/modules/browser`, the `codemode:browser` host module: an agents `Browser` driven from isolate JavaScript with the same `browser.*` functions as `browserTool`. Each run opens one session in its browser scope, runs in one browser scope take turns, and the session's notices go to the run's stderr when it ends. It is experimental.
