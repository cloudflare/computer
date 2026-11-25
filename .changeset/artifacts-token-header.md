---
"@cloudflare/computer": patch
---

`codemode:artifacts` tells code to clone and push with a token in a header, as the docs do, rather than calling `share()`'s URL clone-ready: git saves a clone's URL, token and all, in `.git/config`.
