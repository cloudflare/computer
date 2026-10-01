---
"@cloudflare/computer": minor
---

`createAITools` takes an `exec` option that lists the backends the model can use, each with a note for the model: `exec: { "worker-javascript": "Use for data work." }`. Leave it out to use every backend the Workspace has. The first backend is the default, a note can be `""`, and `exec: {}` means no exec tool. `createExecTool` takes the same map as `backends`, and `defaultBackend` goes away.

`WorkerShellBackend` and `CloudflareContainerBackend` now describe themselves to the model, as `WorkerJavaScriptBackend` does, so the default needs no descriptions. A backend that says nothing gets a one-line default instead of an error.

`shell` still works and is deprecated. `shell: { backends: { id: { description } }, defaultBackend }` becomes `exec: { id: description }` with the default first. Output limits stay on `createExecTool`.
