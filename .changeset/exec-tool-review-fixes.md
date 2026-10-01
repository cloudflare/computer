---
"@cloudflare/computer": patch
---

A `WorkspaceClient` from `getWorkspace()` now answers `runtime.backendIds()`, `runtime.isCallable(id)`, and `runtime.describe(id)`, locally and over RPC, from a snapshot taken when the client is created. `createAITools({ workspace: await getWorkspace(this) })` therefore offers `exec` over every backend, and a callable backend keeps its `input` argument and module list. `CloudflareContainerBackend` describes network access that matches its `egress` setting, and `exec` takes precedence over the deprecated `shell` option.
