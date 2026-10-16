---
"@cloudflare/computer": minor
---

`createGitClient({ auth })` takes a resolver that adds credentials to every HTTPS clone, fetch, pull, and push, including from the shell's `git` command and `ws:git`, so the model never sees the token.
