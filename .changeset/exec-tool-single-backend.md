---
"@cloudflare/computer": minor
---

The `exec` tool offers only the arguments that can work. With one backend there is no `backend` argument, the tool always runs there, `defaultBackend` becomes optional, and the description talks about what that backend does rather than how to choose one. `input` appears only when a configured backend accepts it.

Each backend's entry now adds what the backend says about itself, read through `workspace.runtime.describe(id)`. For `WorkerJavaScriptBackend` that is its source language and every module code can import, so `shell: { backends: { "worker-javascript": {} } }` is enough and the module list the model reads cannot drift from `modules`. A backend `description` is required only for a backend that does not describe itself.
