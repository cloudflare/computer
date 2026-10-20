---
"@cloudflare/computer": patch
---

`getWorkspace()` accepts any Durable Object stub whose class has `__getWorkspaceStub()`, without a cast.
