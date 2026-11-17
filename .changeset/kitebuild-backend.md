---
"@cloudflare/computer": patch
---

Add experimental `KitebuildBackend` at `@cloudflare/computer/backends/kitebuild`, which runs shell commands in a BusyBox Linux userland inside the Workspace's Durable Object. See [Kitebuild backend](https://github.com/cloudflare/computer/blob/main/docs/21_kitebuild_backend.md).
