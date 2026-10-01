---
"@cloudflare/computer": minor
---

Add `createContainerModule()` in `@cloudflare/computer/modules/container`. Install it as `modules: { "ws:container": createContainerModule() }` on a `WorkerJavaScriptBackend`, and JavaScript can run shell commands in the Workspace's `ContainerBackend` with `import { exec } from "ws:container"`. The JavaScript backend fails to connect if that backend is missing. The container shares the Workspace's files, a canceled execution kills the command, and `exec` refuses to run on a read-only backend. The module describes itself, so the `exec` tool tells the model about it without extra configuration.
