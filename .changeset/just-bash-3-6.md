---
"@cloudflare/computer": patch
---

Update `just-bash` to 3.6. The Worker shell keeps running `curl` on plain `fetch`, without `guarded-fetch`. See [Worker backend](https://github.com/cloudflare/computer/blob/main/docs/12_worker_backend.md).
