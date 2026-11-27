---
"@cloudflare/computer": patch
---

The `remoteExec()` Vite plugin takes `sha256`, the hashes of the builds pinned in your repository, and refuses a build that doesn't match them, so a release changed after you pinned it can't reach your Worker; see [remote exec](https://github.com/cloudflare/computer/blob/main/docs/20_remote_exec.md).
