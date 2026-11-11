---
"@cloudflare/computer": patch
---

`codemode:git` exports `fetch`, `pull` and `push`, and `GitClient.cli()` takes `headers`, so code can authenticate with an `Authorization` header instead of a token in the URL. See [`codemode:git`](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#codemodegit).
