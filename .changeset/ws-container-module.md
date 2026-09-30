---
"@cloudflare/computer": minor
---

Add `createContainerModule()` to `@cloudflare/computer/backends/container`. Install the returned module as `ws:container` on a `WorkerJavaScriptBackend`, and JavaScript can run shell commands in the Workspace's container with `import { exec } from "ws:container"`. The container shares the Workspace's files, and a canceled execution kills the running command. `describeContainerModule()` returns text for the model that explains the module.
