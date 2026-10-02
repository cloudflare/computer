---
"@cloudflare/computer": patch
---

A remote `WorkspaceClient` from `getWorkspace(stub)` reports `assets` as `undefined` when the Workspace has no assets publisher, as a local client does. `createAITools` built from a remote client no longer offers a `publish` tool that fails when called.
