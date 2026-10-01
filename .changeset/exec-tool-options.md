---
"@cloudflare/computer": minor
---

`createAITools` takes an `exec` option, and offers the `exec` tool over every backend the Workspace has when you leave it out. Pass a list of backend ids, or a map from id to text for the model, with the default first: `exec: { "worker-javascript": "Use for data work." }`. `true` exposes a backend with no extra text, and `exec: false` turns the tool off. `createExecTool` takes the same `backends`, and `defaultBackend` goes away.

`WorkerShellBackend` and `CloudflareContainerBackend` now describe themselves to the model, as `WorkerJavaScriptBackend` does, so the default needs no descriptions. A backend that says nothing gets a one-line default instead of an error.

`shell` still works and is deprecated. `shell: { backends: { id: { description } }, defaultBackend }` becomes `exec: { id: description }` with the default first. Output limits stay on `createExecTool`.
