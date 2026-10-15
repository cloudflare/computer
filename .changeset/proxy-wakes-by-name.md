---
"@cloudflare/computer": patch
---

`WorkspaceProxy` and `WorkspaceServiceProxy` wake their host Durable Object by name, so `ctx.id.name` survives a wake caused by a container or Dynamic Worker callback. `WorkspaceRef`, `WorkspaceProxyProps` and `WorkspaceServiceProxyProps` accept an optional `name`, filled in from `ctx.id.name` when the backend runs in the host object itself.
