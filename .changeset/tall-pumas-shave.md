---
"@cloudflare/computer": minor
---

Make the artifacts session id optional. `createArtifact(binding)` now returns a client over the whole namespace: names are the ones the binding stores, `list()` returns every repository including those sessions own, and each one can be read, written to, or deleted under its stored name. A `Workspace` with an Artifacts binding and no session id gets that client instead of throwing from its constructor, and `artifacts: { binding, sessionId: null }` asks for it explicitly. Passing a session id behaves as before. `ArtifactClient.sessionId` is now `string | undefined`.
