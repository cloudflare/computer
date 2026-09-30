---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` takes a single `modules` option. A string value is bundled source, as before. A host module runs in the Durable Object under a `ws:*` specifier, and each of its functions becomes a named export, so `modules: { "ws:container": createContainerModule() }` lets code write `import { exec } from "ws:container"`. Build your own with `defineModule({ fn })`, or `defineModule((host) => ({ fn }))` to use the Workspace's Git client, Artifacts client, or runtime. Each function receives `(args, { signal, deadline, access, resolvePath })`.

`ws:git` and `ws:artifacts` are no longer installed automatically. Add `createGitModule()` from `@cloudflare/computer/modules/git` and `createArtifactsModule()` from `@cloudflare/computer/modules/artifacts`. `createContainerModule()` from `@cloudflare/computer/modules/container` runs shell commands in the Workspace's container backend. The container shares the Workspace's files, a canceled execution kills the command, and it refuses to run on a read-only backend. `describeContainerModule()` returns text for the model that explains it. `node:fs` and `node:fs/promises` stay built in.

To migrate, move `trustedModules` entries into `modules` and wrap each in `defineModule()`, replacing any `call(method, args)` handler with one function per method. Replace `allowGitNetwork: true` with `createGitModule({ allowNetwork: true })` and `allowArtifactNetwork: true` with `createArtifactsModule({ allowNetwork: true })`.
