---
"@cloudflare/computer": minor
---

`getWorkspace` returns a client straight away and reaches the Durable Object on the first call, so it can be assigned to a class field. It also accepts a promise of the stub. Awaiting it still gives the loaded client, which knows the Workspace's backends and assets.
