---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` takes a single `modules` option. A string is bundled source, as before. An object of functions is a host module that runs in the Durable Object under a `ws:*` specifier, and each function becomes a named export: `modules: { "ws:weather": { forecast } }` lets code write `import { forecast } from "ws:weather"`. A factory, `(host) => ({ ... })`, builds a host module from the Workspace's Git client, Artifacts client, or runtime. Each function receives `(args, { signal, deadline, access, resolvePath })` and may return any JSON-compatible value.

`ws:git` and `ws:artifacts` are no longer installed automatically. Add `createGitModule()` from `@cloudflare/computer/modules/git` and `createArtifactsModule()` from `@cloudflare/computer/modules/artifacts`. `node:fs` and `node:fs/promises` stay built in.

The backend describes its source language and every importable module for a model in `backend.description`, which `workspace.runtime.backends()` returns along with each backend's id and whether it is callable.

To migrate, move `trustedModules` entries into `modules`, replacing any `call(method, args)` handler with one function per method. Replace `allowGitNetwork: true` with `createGitModule({ allowNetwork: true })` and `allowArtifactNetwork: true` with `createArtifactsModule({ allowNetwork: true })`.
