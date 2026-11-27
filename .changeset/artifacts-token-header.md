---
"@cloudflare/computer": patch
---

`codemode:artifacts` tells code to clone and push with a token in a header, as [the docs](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#codemodeartifacts) do, rather than calling `share()`'s URL clone-ready: git saves a clone's URL, token and all, in `.git/config`.
