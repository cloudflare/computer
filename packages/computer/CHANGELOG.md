# @cloudflare/computer

## 0.7.1

### Patch Changes

- [#252](https://github.com/cloudflare/computer/pull/252) The Git entrypoint hashes with `node:crypto` instead of bundling `sha.js` and its Buffer polyfills, which trims about 120 KB from a Worker that uses it, and the worker-shell modules are minified, shrinking them by 28%. `@cloudflare/computer/tools` and its `ai-sdk`, `pi-ai` and `tanstack-ai` variants also no longer reference the bundled isomorphic-git, which unbundled loaders such as Node and Vite's dev server used to fetch for them. ([`56dd6ab`](https://github.com/cloudflare/computer/commit/56dd6ab6307a2761871f37626da2346840d5dd19)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

## 0.7.0

### Minor Changes

- [#238](https://github.com/cloudflare/computer/pull/238) Add experimental `onInterrupt: "restart" | "replay"` to `WorkerJavaScriptBackend`, so runs interrupted by a deploy or crash can resume. ([`22368fc`](https://github.com/cloudflare/computer/commit/22368fcde29759630561bf5cd439842f5b5f14ef)) - Thanks [@scuffi](https://github.com/scuffi)

- [#251](https://github.com/cloudflare/computer/pull/251) Add experimental `ctx.interrupt()` for host module functions, with `runtime.pending()` and `runtime.respond()`, so a replayable run can wait for an answer such as an approval. ([`5db8dd4`](https://github.com/cloudflare/computer/commit/5db8dd4897c08c4aaf5342bfde5e0aa735eb6122)) - Thanks [@scuffi](https://github.com/scuffi)

### Patch Changes

- [#263](https://github.com/cloudflare/computer/pull/263) `WorkspaceFileStore` and `WORKSPACE_ROOT` are exported from `@cloudflare/computer`, so code outside the tools can read and write workspace files without its own helper. ([`a730798`](https://github.com/cloudflare/computer/commit/a730798b4ab93e7c4314225a76fb3f0bd1e3cb74)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

## 0.6.0

### Minor Changes

- [#255](https://github.com/cloudflare/computer/pull/255) `getWorkspace()` now returns a lazy client immediately which resolves on the first call. `useThink` and the Think compatibility methods are removed; `@cloudflare/think` 0.21 and later take a `Workspace` as it is. ([`9cc3119`](https://github.com/cloudflare/computer/commit/9cc31197d82697bd036cc527292ab39d01d4ffdb)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#237](https://github.com/cloudflare/computer/pull/237) `WorkerJavaScriptBackend` keeps its Durable Object alive while executions run, and adds a `maxCpuMs` option. ([`7415a44`](https://github.com/cloudflare/computer/commit/7415a446b394a733b462917cc6660f2ebb2fd027)) - Thanks [@scuffi](https://github.com/scuffi)

- [#239](https://github.com/cloudflare/computer/pull/239) `just-bash` is now an optional peer dependency and should be installed manually when using `@cloudflare/computer/backends/worker-shell`. ([`5980264`](https://github.com/cloudflare/computer/commit/5980264da104d310a2165b19b599804b589216ec)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

### Patch Changes

- [#257](https://github.com/cloudflare/computer/pull/257) `getWorkspace()` accepts any Durable Object stub whose class has `__getWorkspaceStub()`, without a cast. ([`777097a`](https://github.com/cloudflare/computer/commit/777097a5d2ffdc78d7570c92cea673a58c950e8a)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#244](https://github.com/cloudflare/computer/pull/244) `WorkspaceProxy` and `WorkspaceServiceProxy` wake their host Durable Object by name, so `ctx.id.name` survives a wake caused by a container or Dynamic Worker callback. `WorkspaceRef`, `WorkspaceProxyProps` and `WorkspaceServiceProxyProps` accept an optional `name`, filled in from `ctx.id.name` when the backend runs in the host object itself. ([`b629117`](https://github.com/cloudflare/computer/commit/b629117572315710b22a80c2da2d07d334121b8a)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#241](https://github.com/cloudflare/computer/pull/241) `Workspace`, its filesystem, the worker-javascript backend, mounts, agent tools, Git, Assets, and Artifacts are now stable; `LegacyContainerBackend` is deprecated in favor of `ContainerBackend`; the container and worker-shell backends, `ws:container`, sync, and `computerd` stay experimental. ([`d950ffe`](https://github.com/cloudflare/computer/commit/d950ffee31788fa16c50960f58983a260a22f656)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.5.1

### Patch Changes

- [#229](https://github.com/cloudflare/computer/pull/229) Add `forAISDKTools()` in `@cloudflare/computer/tools/ai-sdk` to serve an AI SDK tool set to isolate JavaScript as `ws:tools`; see [`ws:tools` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wstools). ([`8e50de6`](https://github.com/cloudflare/computer/commit/8e50de6e3dd7385750578bb4406a54f9889c11a8)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#214](https://github.com/cloudflare/computer/pull/214) The `edit` tool bounds its diff with `maxDiffLines` and `maxDiffBytes` and reports `diffTruncated`; see [`edit` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#edit). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#216](https://github.com/cloudflare/computer/pull/216) Fix issue when creating a host module with no functions in the JavaScriptWorkerBackend; see [host module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#host-modules). ([`c798c11`](https://github.com/cloudflare/computer/commit/c798c1121b7b57200a3ae10d441a5b7ea0d0c688)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) The `exec` tool's `input` is an object rather than any JSON value; see [`exec` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) The `exec` tool parses an `input` object sent as a string of JSON; see [`exec` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) Tool sets take `execOutput: { maxLines, maxBytes }` for the `exec` tool's output limits; see [tool option documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#options). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) Host module factories receive the Workspace's assets client as `host.assets`; see [host module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#host-modules). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `WorkerJavaScriptBackend` now lazily reads each host module's description; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#215](https://github.com/cloudflare/computer/pull/215) Mounts can now declare a `version` to support schema migrations; see [mount version documentation](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#versions). ([`50a80cc`](https://github.com/cloudflare/computer/commit/50a80cc3847f0b043df7750725d000a31de5147a)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `createPiTools` results carry each tool's own output as `details`; see [pi documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#pi). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#216](https://github.com/cloudflare/computer/pull/216) Add `ws:tools` to provide the JavaScript worker backend programmatic access to tools; see [`ws:tools` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wstools). ([`c798c11`](https://github.com/cloudflare/computer/commit/c798c1121b7b57200a3ae10d441a5b7ea0d0c688)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) The `grep` tool's `include` and `exclude`, and the `find` tool's `exclude`, take one glob or a list; see [`grep` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#grep). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) Add `@cloudflare/computer/tools/core`, which exports `defineExec` without an agent library; see [tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#what-ships). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) Tool sets take `root` to confine the file tools to one directory; see [root documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#root). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#215](https://github.com/cloudflare/computer/pull/215) Add `WorkerBundle`, a read-only mount that copies files from the deployed bundle or an imported file tree; see [mount documentation](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#workerbundlesource-options). ([`50a80cc`](https://github.com/cloudflare/computer/commit/50a80cc3847f0b043df7750725d000a31de5147a)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#215](https://github.com/cloudflare/computer/pull/215) Add `@cloudflare/computer/vite` with a `computerBundle()` plugin that bundles a directory into a Vite-built worker for `WorkerBundle`; see [mount documentation](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#shipping-the-files-with-vite). ([`50a80cc`](https://github.com/cloudflare/computer/commit/50a80cc3847f0b043df7750725d000a31de5147a)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `ws:artifacts` adds `createToken` and `share` for minting git tokens and clone URLs; see [`ws:artifacts` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wsartifacts). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) Add `ws:assets` so isolate JavaScript can publish a Workspace file to a time-limited URL; see [`ws:assets` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wsassets). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `createContainerModule({ maxOutputLines })` limits each `ws:container` stream by lines as well as bytes; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `createContainerModule({ prelude })` runs shell text such as `set -o pipefail` before each `ws:container` command; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `ws:container` now keeps the end of each stream for a Workspace with `output: false`; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#214](https://github.com/cloudflare/computer/pull/214) `ws:tools` lists the tools code can import in its description; see [`ws:tools` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wstools). ([`f1ac4ce`](https://github.com/cloudflare/computer/commit/f1ac4ce9f244cefd81615dabb33a1ca728dba30d)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.5.0

### Minor Changes

- [#210](https://github.com/cloudflare/computer/pull/210) `createAITools` moves to `@cloudflare/computer/tools/ai-sdk`; see [tool wiring documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#wiring-up). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) The `exec` option (now `ExecBackendOptions`) has been refactored to use `runtime.backends()`; see [tool option documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#options). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) The `exec` tool shows the last `maxLines` (2000) lines or `maxBytes` of each stream with a pointer to the full output on disk; see [`exec` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) `ws:git` and `ws:artifacts` are no longer installed by default: add `createGitModule()` and `createArtifactsModule()`; see [`ws:git` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wsgit). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#172](https://github.com/cloudflare/computer/pull/172) Remove `WorkerJavaScriptBackend`'s `maxConcurrentExecutions` option, leaving the platform's own limit on concurrent Dynamic Workers; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention). ([`0ecfff4`](https://github.com/cloudflare/computer/commit/0ecfff438c11cdb95b3e623813857fc9c15b729f)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#210](https://github.com/cloudflare/computer/pull/210) Consolidate `trustedModules` with `modules` in `WorkerJavaScriptBackend`; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#host-modules). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) `runtime.exec` results keep only the last 2000 lines or 64 KiB of each stream and save the full output to a Workspace file, configured with `new Workspace({ output })` or turned off with `output: false`; see [long output documentation](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#long-output). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) Fix an issue in `JavaScriptWorkerBackend` where a source module could import a Workspace file; see [source module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#source-modules). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

### Patch Changes

- [#210](https://github.com/cloudflare/computer/pull/210) JavaScriptWorkerBackend now supports absolute imports e.g. `/workspace/lib/util.js`; see [import documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#durable-imports). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) Improve `WorkerShellBackend` and `ContainerBackend` tool descriptions including egress information; see [`exec` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) Add `runtime.backends()` to `WorkspaceClient` allowing tools to be created from workspace stubs; see [tool wiring documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#wiring-up). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#213](https://github.com/cloudflare/computer/pull/213) The `exec` tool now tells the model to put module code in an `export default async function (input)` shape. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#171](https://github.com/cloudflare/computer/pull/171) The `exec` tool only documents `backend` and `input` when needed; see [`exec` tool documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec). ([`c40642e`](https://github.com/cloudflare/computer/commit/c40642e55e1b14374a7d1cb692ea37b192714511)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#210](https://github.com/cloudflare/computer/pull/210) A cyclic argument to a `node:fs` or host module call fails with a "must be acyclic" error; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#213](https://github.com/cloudflare/computer/pull/213) Isolate JavaScript modules now need a default export, and fail before running without one. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#213](https://github.com/cloudflare/computer/pull/213) Isolate JavaScript code can now import Node.js built-ins such as `node:path`, `node:crypto`, and `node:zlib`. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#213](https://github.com/cloudflare/computer/pull/213) The JavaScript backend now creates its root directory (`/workspace`) if the Workspace doesn't have one. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#210](https://github.com/cloudflare/computer/pull/210) The JavaScriptWorkerBackend now strips non-serializable return values matching JSON.stringify(); see [isolate JavaScript documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#isolate-javascript-runtime). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#213](https://github.com/cloudflare/computer/pull/213) Isolate JavaScript runs now fail on I/O at module scope or an unhandled rejection, instead of completing silently, with no output. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#172](https://github.com/cloudflare/computer/pull/172) `JavaScriptWorkerBackend` now uses native RPC for `modules` bindings; see [execution limit documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#execution-limits-and-retention). ([`0ecfff4`](https://github.com/cloudflare/computer/commit/0ecfff438c11cdb95b3e623813857fc9c15b729f)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#210](https://github.com/cloudflare/computer/pull/210) Imports of `ws:*` and other configured modules work when `compatibilityFlags` includes `new_module_registry`; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#172](https://github.com/cloudflare/computer/pull/172) Tools built from a remote `getWorkspace()` client of a Workspace without an assets publisher no longer offer a `publish` tool; see [tool wiring documentation](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#wiring-up). ([`0ecfff4`](https://github.com/cloudflare/computer/commit/0ecfff438c11cdb95b3e623813857fc9c15b729f)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#210](https://github.com/cloudflare/computer/pull/210) Add `workspace.runtime.backends()`, which lists each backend's id, protocol, whether it is callable, and its description for a model, including the modules a `WorkerJavaScriptBackend` can import; see [backend routing documentation](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#backend-routing). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#210](https://github.com/cloudflare/computer/pull/210) Each `JavaScriptWorkerBackend` now only stores each module once, so a large bundle counts once; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#213](https://github.com/cloudflare/computer/pull/213) A DO's `ctx.storage` can now be passed to a Workspace without casting. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#213](https://github.com/cloudflare/computer/pull/213) Workspace filesystem errors no longer repeat the path. ([`3249dce`](https://github.com/cloudflare/computer/commit/3249dce488e2d44727f16483e3fa86eb966b8dac)) - Thanks [@scuffi](https://github.com/scuffi)

- [#172](https://github.com/cloudflare/computer/pull/172) Add `ws:container` so isolate JavaScript can run shell commands in the Workspace's `ContainerBackend`; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer). ([`0ecfff4`](https://github.com/cloudflare/computer/commit/0ecfff438c11cdb95b3e623813857fc9c15b729f)) - Thanks [@mattzcarey](https://github.com/mattzcarey)

- [#210](https://github.com/cloudflare/computer/pull/210) `ws:git`'s `cli` accepts a leading `-C <path>` as its working directory; see [`ws:git` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wsgit). ([`154ca10`](https://github.com/cloudflare/computer/commit/154ca10b8fa0d7e0e857280ae5e6bd693668d3c2)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.4.1

### Patch Changes

- [#192](https://github.com/cloudflare/computer/pull/192) Add `ignore` to `ContainerBackend`: glob patterns, such as `**/node_modules` and `!/vendor/node_modules`, for paths the container keeps on its own disk instead of syncing. ([`2f76387`](https://github.com/cloudflare/computer/commit/2f76387771c9e4a64dc08a7bbd82cbbcf9fadec1)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.4.0

### Minor Changes

- [#161](https://github.com/cloudflare/computer/pull/161) Rename the platform-scheduled container backend to `LegacyContainerBackend`; see [container backend documentation](https://github.com/cloudflare/computer/blob/main/docs/07_injected_service.md#cloudflare-containers-specifics). ([`736fcdd`](https://github.com/cloudflare/computer/commit/736fcdd9367dfabff8bfbec6ee51e47b108e0e1e)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#191](https://github.com/cloudflare/computer/pull/191) Add Workspace tool sets for pi (`createPiTools` from `@cloudflare/computer/tools/pi-ai`) and TanStack AI (`createTanStackTools` from `@cloudflare/computer/tools/tanstack-ai`); see [the tool interface docs](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md). ([`960d85b`](https://github.com/cloudflare/computer/commit/960d85bc94b28c64c001b1266a5388ff8e66dd44)) - Thanks [@aron-cf](https://github.com/aron-cf)

### Patch Changes

- [#187](https://github.com/cloudflare/computer/pull/187) Keep configured paths local to the container instead of syncing them with the Durable Object using `ContainerBackend.ignore`; see [local-only path documentation](https://github.com/cloudflare/computer/blob/main/docs/19_performance.md#local-only-paths-mount_ignore). ([`f15437c`](https://github.com/cloudflare/computer/commit/f15437c9b7ce0fecfd39c32951e58232db4c55b4)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#162](https://github.com/cloudflare/computer/pull/162) Add `ContainerBackend` for durable-object-scheduled containers; see [container backend documentation](https://github.com/cloudflare/computer/blob/main/docs/07_injected_service.md#cloudflare-containers-specifics). ([`390fd7b`](https://github.com/cloudflare/computer/commit/390fd7bfd788c69b8b8625c3939b8ef348682691)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#141](https://github.com/cloudflare/computer/pull/141) Expand `ws:git` with full-history clones by default and additional `cat-file`, `log`, and command-specific `help` options; see [Git interface documentation](https://github.com/cloudflare/computer/blob/main/docs/13_git_interface.md). ([`4bc1028`](https://github.com/cloudflare/computer/commit/4bc102804c7dd39ba8b3dc580438755767beddcf)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.2

### Patch Changes

- [#150](https://github.com/cloudflare/computer/pull/150) Add an `exclude` option to `fs.grep`, matching `fs.find`. ([`e5e28a7`](https://github.com/cloudflare/computer/commit/e5e28a79d74f1e173006193bf3eeb0d990c98930)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.1

### Patch Changes

- [#124](https://github.com/cloudflare/computer/pull/124) Document the symbolic-link filesystem surface under `docs/04_filesystem_interface.md`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) Extend `Workspace.fs` to include `rename(oldPath, newPath)`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#124](https://github.com/cloudflare/computer/pull/124) `find` now accepts `exclude` e.g. `ws.fs.find("/workspace", "**/*.ts", { exclude: ["node_modules/**"], })`. ([`e6a92c5`](https://github.com/cloudflare/computer/commit/e6a92c50cb53997bd601bdce0563b96276d0f8fc)) - Thanks [@aron-cf](https://github.com/aron-cf)

- [#145](https://github.com/cloudflare/computer/pull/145) Improve performance of git diff when given named paths. ([`a495760`](https://github.com/cloudflare/computer/commit/a495760138c163ac88d1b05632c90f3bcc4cd3f5)) - Thanks [@aron-cf](https://github.com/aron-cf)

## 0.3.0

### Minor Changes

- [#110](https://github.com/cloudflare/computer/pull/110) [`c85a255`](https://github.com/cloudflare/computer/commit/c85a25597ab9c28c8f50245f6ec24d76532794df) Thanks [@aron-cf](https://github.com/aron-cf)! - The container's HTTP surface now requires a bearer token. The host generates a secret, passes it to the container as RPC_CLIENT_SECRET at launch, and sends it on /connect. Readiness at /health stays open, and leaving the variable unset disables the checks. Before opening a session the host checks that the container refuses an unauthenticated request and fails the connect if it does not, so a container or image predating this has to be recycled. The container's dial-back to the host carries the same secret, and the host refuses an upgrade that does not present it.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The /connect caller now provides both API & healthcheck endpoints. The container no longer builds either path itself, so a host is free to serve them wherever it likes.

- [#110](https://github.com/cloudflare/computer/pull/110) [`199fc17`](https://github.com/cloudflare/computer/commit/199fc1740b019cae0274b810d99861b093e2a3e4) Thanks [@aron-cf](https://github.com/aron-cf)! - `IWorkspaceContainerAPI.start()` and `restart()` now take a single `ContainerLaunchSpec` of `{ env, enableInternet }` instead of two arguments, and return which of `launched`, `adopted` or `relaunched` happened. Each launch records its spec, and a container found already running is relaunched unless it matches, because neither the environment nor the internet flag can be changed on a live container. A container started outside this API has no record and is relaunched rather than trusted. `setInactivityTimeout()` joins the interface so a caller that pre-starts containers, such as a warm pool, does not need to reach past it.

- [#110](https://github.com/cloudflare/computer/pull/110) [`c85a255`](https://github.com/cloudflare/computer/commit/c85a25597ab9c28c8f50245f6ec24d76532794df) Thanks [@aron-cf](https://github.com/aron-cf)! - A command run through the shell no longer inherits the container's whole environment. It receives PATH, HOME, TMPDIR, TZ, LANG, TERM, the LC* family, and any variable prefixed COMPUTER_VAR*, which arrives with the prefix stripped so COMPUTER_VAR_NODE_ENV becomes NODE_ENV. A workspace that relied on some other inherited variable needs the prefix.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The UPSTREAM_URL environment variable has been removed along with the container's own sync loop. Syncing is driven by whichever peer holds the other end of the Cap'n Web session.

- [#108](https://github.com/cloudflare/computer/pull/108) [`3074d90`](https://github.com/cloudflare/computer/commit/3074d9027b6fa1e1f3742cb715fd4914199c85b4) Thanks [@aron-cf](https://github.com/aron-cf)! - The Cap'n Web /ws endpoint has been renamed to /api at both ends of the connection. A durable object that routes the container's outbound upgrade must match /api in its own fetch handler. Support for the Cap'n Web HTTP batch transport has been removed, so /api carries a websocket only.

- [#138](https://github.com/cloudflare/computer/pull/138) [`25c603a`](https://github.com/cloudflare/computer/commit/25c603ac47b32a9969ec2a9ac9260c9cd8440749) Thanks [@aron-cf](https://github.com/aron-cf)! - `Workspace.pull()` and `Workspace.push()` are now async iterables that commit one block of changes per iteration. This allows a caller to implement a deferred post-exec sync across several invocations. See [./docs/02_sync_protocol.md](./docs/02_sync_protocol.md) for details.

- [#109](https://github.com/cloudflare/computer/pull/109) [`e2dd6d8`](https://github.com/cloudflare/computer/commit/e2dd6d8f9a5d078024cad52fff179bbb33fc3597) Thanks [@aron-cf](https://github.com/aron-cf)! - Make the artifacts session id optional: `createArtifact(binding)` now returns a client over the whole namespace rather than requiring a session to scope by. See [./docs/15_artifacts_interface.md](./docs/15_artifacts_interface.md) for details.

### Patch Changes

- [#111](https://github.com/cloudflare/computer/pull/111) [`e9bbc50`](https://github.com/cloudflare/computer/commit/e9bbc50103c7eeea258b83faf3049d64830bc037) Thanks [@aron-cf](https://github.com/aron-cf)! - Create missing parent directories while applying sync entries.

- [#96](https://github.com/cloudflare/computer/pull/96) [`45fa716`](https://github.com/cloudflare/computer/commit/45fa7163563f3f5ddb8398aece6f6ed64be58ed9) Thanks [@agent-think](https://github.com/apps/agent-think)! - Fix issue where the edit tool would rewrite the whole file when oldText doesn't match exactly.

- [#113](https://github.com/cloudflare/computer/pull/113) [`f35f5df`](https://github.com/cloudflare/computer/commit/f35f5dfd06d57f801414a3a0583669267f092ed9) Thanks [@aron-cf](https://github.com/aron-cf)! - Sync `node_modules` by default so package manager installs persist across workspace runtimes.

## 0.2.1

### Patch Changes

- [#102](https://github.com/cloudflare/computer/pull/102) [`e09135b`](https://github.com/cloudflare/computer/commit/e09135bbdbff4a50a487afae47be4ad3c31d1a60) Thanks [@agent-think](https://github.com/apps/agent-think)! - Embed the configured byte limit directly in Worker JavaScript capability size errors.

- [#95](https://github.com/cloudflare/computer/pull/95) [`1e6c027`](https://github.com/cloudflare/computer/commit/1e6c02791b6825ccdc743be17c402a4798ed7084) Thanks [@agent-think](https://github.com/apps/agent-think)! - Add support for short revision ids in the git module.

- [#103](https://github.com/cloudflare/computer/pull/103) [`8afbb7c`](https://github.com/cloudflare/computer/commit/8afbb7c340fb4ab08626cca576dba15eb7e7ed72) Thanks [@aron-cf](https://github.com/aron-cf)! - `container-shell` operations now reconnect after computerd restarts when retrying is safe, and process-local execution handles return `EEXEC_LOST` after container replacement. See [container connection recovery](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#command-synchronization).

## 0.2.0

### Minor Changes

- [#88](https://github.com/cloudflare/computer/pull/88) [`9ecb912`](https://github.com/cloudflare/computer/commit/9ecb912bbf0cfc17e48e8963d4ae104d4b404be9) Thanks [@aron-cf](https://github.com/aron-cf)! - Consolidate egress configuration across the existing backends. See [./examples/egress](./examples/egress) for details.

- [`2bfce96`](https://github.com/cloudflare/computer/commit/2bfce96829dbb8045733d130016b7d60f60abe0e) Thanks [@aron-cf](https://github.com/aron-cf)! - Expose bounded workspace byte reads through RPC and return paginated directory listings with file metadata.

- [`19a65bc`](https://github.com/cloudflare/computer/commit/19a65bce35ac352a73ebbb19d9ee3b89851928eb) Thanks [@aron-cf](https://github.com/aron-cf)! - Extend the `read` tool to support image and data formats.

- [`f673226`](https://github.com/cloudflare/computer/commit/f6732261d639b34a07f836672e54a374afa34b89) Thanks [@aron-cf](https://github.com/aron-cf)! - Updated `find` and `grep` tools to support additional filtering parameters, a `delete` tool.

- [#41](https://github.com/cloudflare/computer/pull/41) [`a753db7`](https://github.com/cloudflare/computer/commit/a753db7ead38a3028939a87ee9dc087da38d9928) Thanks [@aron-cf](https://github.com/aron-cf)! - Reduced the size of bundles using worker-shell by making many commands opt-in. See the [documentation](/docs/12_worker_backend.md) for details.

### Patch Changes

- [#87](https://github.com/cloudflare/computer/pull/87) [`8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) Thanks [@aron-cf](https://github.com/aron-cf)! - Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.

- [#77](https://github.com/cloudflare/computer/pull/77) [`5062158`](https://github.com/cloudflare/computer/commit/50621582410c8933d313eddf8fb362596ffd9d29) Thanks [@aron-cf](https://github.com/aron-cf)! - Fix git diff/status/log edge cases, batch sync hash probes within Durable Object SQLite limits, and count tracked RPC targets by identity.
