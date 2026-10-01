---
"@cloudflare/computer": minor
---

`createAITools` takes an `exec` option that lists the backends the model can use, keyed by backend id: `exec: { "worker-javascript": { description: "Use for data work." } }`. Leave it out to use every backend the Workspace has. `{}` exposes a backend with nothing beyond its own description, and `exec: {}` means no exec tool. `createExecTool` takes the same map as `backends`, and `defaultBackend` goes away: with more than one backend the model must name one on every call.

`WorkerShellBackend` and `CloudflareContainerBackend` now describe themselves to the model, as `WorkerJavaScriptBackend` does, so the default needs no descriptions. A backend that says nothing gets a one-line default instead of an error.

`shell` still works and is deprecated. `shell: { backends }` becomes `exec: backends`, and its `defaultBackend` is ignored. Output limits stay on `createExecTool`.

`createAITools` moves to its own entry point, `@cloudflare/computer/tools/ai-sdk`. `@cloudflare/computer/tools` keeps the individual `create*Tool` functions and `WorkspaceFileStore`. Change `import { createAITools } from "@cloudflare/computer/tools"` to `from "@cloudflare/computer/tools/ai-sdk"`.
