---
"@cloudflare/computer": minor
---

`codemode:git` exports `fetch`, `pull` and `push`, and `GitClient.cli()` takes `headers` for its network subcommands, so isolate code can authenticate with an `Authorization` header instead of a token in the remote URL.
