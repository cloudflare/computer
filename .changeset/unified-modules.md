---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` takes a single `modules` option. A string is bundled source, as before. An object of functions is a host module that runs in the Durable Object under a `ws:*` specifier, and each function becomes a named export: `modules: { "ws:weather": { forecast } }` lets code write `import { forecast } from "ws:weather"`. A factory, `(host) => ({ ... })`, builds a host module from the Workspace's Git client, Artifacts client, or runtime. Each function receives `(args, { signal, deadline, access, resolvePath })` and may return any JSON-compatible value.

`ws:git` and `ws:artifacts` are no longer installed automatically. Add `createGitModule()` from `@cloudflare/computer/modules/git` and `createArtifactsModule()` from `@cloudflare/computer/modules/artifacts`. `createContainerModule()` from `@cloudflare/computer/modules/container` runs shell commands in the Workspace's container backend. The container shares the Workspace's files, a canceled execution kills the command, and it refuses to run on a read-only backend. `node:fs` and `node:fs/promises` stay built in.

The backend now describes its source language and every module for a model, and the `exec` tool shows that text. A backend's `description` in the tool options becomes optional when the backend describes itself, so the module list the model reads always matches what is installed. The tool also stops offering `input` when no configured backend accepts it.

To migrate, move `trustedModules` entries into `modules`, replacing any `call(method, args)` handler with one function per method. Replace `allowGitNetwork: true` with `createGitModule({ allowNetwork: true })` and `allowArtifactNetwork: true` with `createArtifactsModule({ allowNetwork: true })`.
