---
"@cloudflare/computer": minor
---

`createAITools` takes an `exec` option that lists the backends the model can use, keyed by backend id: `exec: { "worker-javascript": { description: "Use for data work." } }`. Leave it out to use every backend the Workspace has. The first backend is the default, `{}` exposes a backend with nothing beyond its own description, and `exec: {}` means no exec tool. `createExecTool` takes the same map as `backends`, and `defaultBackend` goes away.

`WorkerShellBackend` and `CloudflareContainerBackend` now describe themselves to the model, as `WorkerJavaScriptBackend` does, so the default needs no descriptions. A backend that says nothing gets a one-line default instead of an error.

`shell` still works and is deprecated. `shell: { backends, defaultBackend }` becomes `exec: backends` with the default first. Output limits stay on `createExecTool`.
