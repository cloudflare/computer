---
"@cloudflare/computer": minor
---

Make the artifacts session id optional: `createArtifact(binding)` now returns a client over the whole namespace rather than requiring a session to scope by. See [./docs/15_artifacts_interface.md](./docs/15_artifacts_interface.md) for details.
