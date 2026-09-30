---
"@cloudflare/computer": minor
---

The `exec` tool has no `backend` argument when only one backend is configured. It always runs there, its description no longer talks about choosing a backend, and `defaultBackend` becomes optional. A single shell backend also drops the `input` argument it could never accept, and a single callable backend describes `command` as ES module source. With more than one backend, nothing changes and `defaultBackend` is still required.
