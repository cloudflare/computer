---
"@cloudflare/computer": minor
---

Adds the experimental `ws:browser` host module (`@cloudflare/computer/modules/browser`), which lets isolate JavaScript drive a persistent browser over the Chrome DevTools Protocol. It takes anything with a `name` and a `session()`, such as `Browser` from `agents/browser`, and opens one session per run.
