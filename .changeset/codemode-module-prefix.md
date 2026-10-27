---
"@cloudflare/computer": minor
---

Host and source modules for `WorkerJavaScriptBackend` that used `ws:*` names now use the `codemode:` prefix instead of `ws:`. Rename `ws:git`, `ws:artifacts`, `ws:assets`, `ws:container`, `ws:tools`, and your own modules under `ws:` to `codemode:*` in both `modules` and imports.
