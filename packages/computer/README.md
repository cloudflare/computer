# `@cloudflare/computer`

A persistent, SQLite-backed virtual filesystem for Durable Objects,
with pluggable command and code execution. Built for agents that need a
small, portable working directory and the tools to read, write, and run
things in it.

> [!IMPORTANT]
> **PREVIEW ONLY.** This package is provided as a preview for feedback
> only. APIs are unstable and the design is subject to change. Suitable
> for experiments, exploration, and prototypes. It is NOT suitable for
> production use at this time.

## What you get

- **A filesystem in your Durable Object.** `workspace.fs` looks like
  `node:fs/promises` — `readFile`, `writeFile`, `mkdir`, `readdir`,
  `rm`, `grep` — and is durable across DO restarts, backed by the DO's
  own SQLite storage.
- **One execution surface, several backends.**
  `workspace.runtime.exec()` runs a shell command or an ECMAScript
  module. Pick a full Linux container, a fast in-Worker shell, or an
  isolated JavaScript runtime, all against the same files.
- **Batteries for agents.** Ready-made [AI SDK](https://github.com/vercel/ai)
  tools (`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and optional
  `exec`), a git client, R2-backed read-only mounts, and helpers for publishing
  files.

The Workspace can also run with no execution backend at all, giving you
just the filesystem.

### Limits

- ~10 GB per workspace (it shares storage with the DO).
- The container-side filesystem is held in memory. Aim for agent-scale
  workspaces, not full monorepos.
- Container access goes through FUSE, so heavy I/O (large `node_modules`
  installs, big tarball extractions) is slower than a native disk. See
  [`docs/19_performance.md`](../../docs/19_performance.md).

## Installation

```sh
npm install @cloudflare/computer
```

Your Worker needs the `nodejs_compat` compatibility flag. The
worker-shell and worker-javascript backends additionally need the
`experimental` flag and a Worker Loader binding. Each backend has its
own binding requirements — see [Choosing a backend](#choosing-a-backend).

Optional peer dependencies, installed only if you use the matching
feature: `ai` and `zod` (for `@cloudflare/computer/tools`),
`@platformatic/vfs` (for the Node-side VFS provider).

## Quick start

The smallest useful thing is a filesystem with no execution backend. Add
`withWorkspace` to a Durable Object and you have durable files:

```ts
import { withWorkspace, getWorkspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

export class Agent extends withWorkspace(
  class extends DurableObject<Env> {},
  (self) => ({ storage: self.ctx.storage }),
) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.Agent.idFromName("user-123");
    using ws = await getWorkspace(env.Agent.get(id));

    await ws.fs.writeFile("/notes.md", "- [ ] ship it\n");
    const notes = await ws.fs.readFile("/notes.md", "utf8");

    return new Response(notes);
  },
} satisfies ExportedHandler<Env>;
```

`wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "Agent", "class_name": "Agent" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Agent"] }
  ]
}
```

To run commands against those files, add an execution backend. The
worker-shell backend needs no container and no Docker, so it's the
quickest way to get `exec` working:

```ts
import { withWorkspace, getWorkspace } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import curlModules from "@cloudflare/computer/shell/curl";
import { DurableObject } from "cloudflare:workers";

export class Agent extends withWorkspace(
  class extends DurableObject<Env> {},
  (self) => ({
    storage: self.ctx.storage,
    backends: [
      new WorkerShellBackend({
        loader: self.env.LOADER,
        workspace: { binding: "Agent", id: self.ctx.id.toString() },
        ctx: self.ctx,
        commands: [curlModules],
      }),
    ],
  }),
) {}
```

Add the loader binding and the `experimental` flag to `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

The worker shell ships as feature groups: an always-on core plus
one optional group per command at
`@cloudflare/computer/shell/<feature>`. Import the groups you want
and pass them to `WorkerShellBackend`'s `commands` option; a group you
never import is unreachable in your bundle and the bundler drops
it. The optional groups are `curl`, `html-to-markdown`, `python`,
`sqlite`, `js-exec`, `yq`, `file`, `xan`, and `jq`. `curl` runs on
the isolate's global `fetch` (no `undici` in the bundle); egress
stays governed by the Dynamic Worker's `globalOutbound`.

Now `exec` runs against the same files your `fs` calls wrote:

```ts
using ws = await getWorkspace(env.Agent.get(id));
await ws.fs.writeFile("/hello.txt", "world");
using run = await ws.runtime.exec("cat /hello.txt");
const { stdout, exitCode } = await run.result();
```

For a full, runnable version of this see
[`examples/worker-shell`](../../examples/worker-shell).

## The filesystem

`workspace.fs` is async, uses absolute paths, and is durable across DO
restarts. Strings default to UTF-8; pass a `Uint8Array` or a
`ReadableStream` for binary content.

```ts
// Write a string, bytes, or a stream straight to disk.
await ws.fs.writeFile("/notes/todo.md", "- [ ] ship it\n");
await ws.fs.writeFile("/data/blob.bin", new Uint8Array([1, 2, 3]));
await ws.fs.writeFile("/uploads/big.csv", request.body!);

// Read back as a string or as a stream.
const todo = await ws.fs.readFile("/notes/todo.md", "utf8");
const stream = await ws.fs.readFile("/uploads/big.csv");
return new Response(stream);

// Directories.
await ws.fs.mkdir("/notes/daily", { recursive: true });
for (const entry of await ws.fs.readdir("/notes")) {
  console.log(entry.isDirectory ? `d ${entry.name}` : `f ${entry.name}`);
}

// Remove and search.
await ws.fs.rm("/notes/daily", { recursive: true });
const hits = await ws.fs.grep("TODO", "/", { ignoreCase: true });
```

See [`docs/04_filesystem_interface.md`](../../docs/04_filesystem_interface.md)
for the full surface.

### Read-only mounts

Pre-fill part of the tree from an R2 bucket. Files under the mount point
are read-only; writes reject with `EROFS`.

```ts
import { R2Bucket } from "@cloudflare/computer";

new Workspace({
  storage: ctx.storage,
  mounts: { "/workspace/r2": R2Bucket(env.Bucket) },
});
```

## Running commands and code

`workspace.runtime.exec(source, options)` is the single execution entry
point. What `source` means depends on the backend: a shell command for
the container and worker-shell backends, an ECMAScript module for the
worker-javascript backend.

```ts
using run = await ws.runtime.exec("ls -la /workspace", { encoding: "utf8" });
const { stdout, stderr, exitCode } = await run.result();
```

The handle is also a `ReadableStream` of live events, so you can forward
output as it happens — for example, as Server-Sent Events:

```ts
async fetch(request: Request) {
  const run = await ws.runtime.exec("npm test", { encoding: "utf8" });

  const sse = run.pipeThrough(
    new TransformStream({
      transform(event, controller) {
        const frame = `event: ${event.name}\ndata: ${JSON.stringify(event.value)}\n\n`;
        controller.enqueue(new TextEncoder().encode(frame));
      },
    }),
  );

  return new Response(sse, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
```

Alongside `exec`, the runtime exposes `getExec`, `killExec`, and
`disposeExec`. See
[`docs/05_runtime_interface.md`](../../docs/05_runtime_interface.md).

### Choosing a backend

| Backend | Import | Runs | Needs |
| --- | --- | --- | --- |
| **Container** | `@cloudflare/computer/backends/container` | Shell commands in full Linux userland (real binaries, `npm`, `node`, network) | A Cloudflare Container running `computerd` |
| **Worker shell** | `@cloudflare/computer/backends/worker-shell` | Shell commands via [just-bash](https://github.com/vercel-labs/just-bash) in a Dynamic Worker | A Worker Loader binding; `experimental` flag |
| **Worker JavaScript** | `@cloudflare/computer/backends/worker-javascript` | ECMAScript modules in a fresh Dynamic Worker | A Worker Loader binding; `experimental` flag |

- **Container** cold-starts more slowly but gives you a real Linux
  environment. The container owns its own SQLite-backed VFS and this
  package syncs the two stores across a capnweb WebSocket. See
  [`docs/07_injected_service.md`](../../docs/07_injected_service.md) for
  the container image, and [`examples/container`](../../examples/container).
- **Worker shell** is fast and needs no container. Every filesystem
  operation forwards back to the same Durable Object, so there's no
  second store and no sync round trip. See
  [`docs/12_worker_backend.md`](../../docs/12_worker_backend.md) and
  [`examples/worker-shell`](../../examples/worker-shell).
- **Worker JavaScript** evaluates a module with structured
  input/results, durable relative imports, configured libraries,
  Workspace-backed `node:fs/promises`, and trusted `ws:git` /
  `ws:artifacts` modules. It runs after `runtime.exec()` returns; the
  run stays alive while its event stream is consumed. See
  [`docs/17_isolate_javascript.md`](../../docs/17_isolate_javascript.md)
  and [`examples/worker-javascript`](../../examples/worker-javascript).

You can register several backends on one Workspace and route each call
to a named one — see [Multiple backends](#multiple-backends).

## Tools for agents

`@cloudflare/computer/tools` ships AI SDK tools that wrap the Workspace
surfaces, ready to hand to `generateText`, `streamText`, or an agent
framework's `getTools()`. The default set is `read`, `ls`, `find`,
`grep`, `write`, `edit`, and `delete`; `exec` and `publish` are added
when you configure them. Read-only mode keeps `read`, `ls`, `find`, and
`grep`.

```ts
import { createAITools } from "@cloudflare/computer/tools";

const tools = createAITools({
  workspace,
  read: { maxBytes: 32 * 1024, maxLines: 800 },
  shell: {
    defaultBackend: "shell",
    backends: {
      shell: { description: "Fast Worker shell with built-in text commands." },
      container: { description: "Full Linux userland in a Cloudflare Container." },
    },
  },
});
```

The model reads each backend's `description` when deciding where a
command should run, so write them in plain language. Truncated text
model output keeps both line and byte continuations; pass both to the
next call to avoid transferring the same bytes again. Eligible image and
PDF bytes are captured once during the bounded tool execution and returned
as AI SDK `file` model output without re-reading the file. SVG source remains
text. `ls`, `find`, and `grep` pass pagination through to the storage layer
and return `nextOffset` when more results exist. File mutations share
locks across tool sets for the same workspace, and recursive deletion
excludes mutations throughout its subtree. See
[`docs/09_tool_interface.md`](../../docs/09_tool_interface.md).

## Git

`workspace.git` is an opt-in typed git client backed by
[`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git),
operating directly on the local SQLite VFS — no backend or shell
required. Enable it by passing `createGitClient()` from
`@cloudflare/computer/git`:

```ts
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";

const ws = new Workspace({
  storage: ctx.storage,
  git: createGitClient(),
  defaultGitIdentity: { name: "Agent", email: "agent@example.test" },
});

await ws.git.clone({ url: "https://github.com/example/repo.git" });
await ws.fs.writeFile("/notes.md", "hello");
await ws.git.add({ paths: ["notes.md"] });
await ws.git.commit({ message: "add notes" });
```

The git subpath bundles `isomorphic-git` lazily and swaps its `pako`
dependency for the Workers `node:zlib` implementation, so the default
package graph stays free of git. There's also an argv entry point
(`workspace.git.cli({ argv })`), and when git is configured the
worker-shell backend exposes a built-in `git` command. See
[`docs/13_git_interface.md`](../../docs/13_git_interface.md).

## Sharing files

Two ways to get a file out of the workspace and into the world:

- **Assets** (`@cloudflare/computer/assets`): `createAssets(...).share`
  uploads a workspace file to R2 and returns a presigned URL. Attach it
  through `WorkspaceOptions.assets` to expose an in-shell
  `assets publish <path> [<expiry>]` command. See
  [`docs/14_assets_interface.md`](../../docs/14_assets_interface.md).
- **Artifacts** (`@cloudflare/computer/artifacts`):
  `createArtifact(binding, sessionId)` is a session-scoped facade over
  the [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
  binding. Every repository name is implicitly prefixed with the session
  id, so one namespace hosts many isolated sessions.

```ts
import { createArtifact } from "@cloudflare/computer/artifacts";

const artifacts = createArtifact(env.ARTIFACTS, agentId);
const repo = await artifacts.create("build-cache", { description: "CI artifacts" });
const token = await artifacts.createToken("build-cache", "read", 3600);
const mine = await artifacts.list(); // only this session's repos
```

Artifacts also offers an argv CLI (`artifacts.cli({ argv })`), and when
`Workspace` is configured with an Artifacts binding the worker-shell
backend exposes an `artifacts` command. See
[`docs/15_artifacts_interface.md`](../../docs/15_artifacts_interface.md).

## Crossing the Worker → DO boundary

The Durable Object owns the Workspace; a Worker reaches it through a
stub. `withWorkspace` installs the plumbing, and `getWorkspace(stub)`
returns a client:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.Agent.idFromName("user-123");
    using ws = await getWorkspace(env.Agent.get(id));

    await ws.fs.writeFile("/notes.md", "hello");
    using run = await ws.runtime.exec("ls /workspace");
    const { exitCode, stdout } = await run.result();

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

### Dispose your stubs

The one gotcha worth internalizing: the RPC layer does not
garbage-collect remote stubs. On long-lived sessions undisposed stubs
accumulate on the peer until the session ends. The rules are short:

- `using` the value from `getWorkspace(...)`.
- `using` the handle from `ws.runtime.exec(...)`.
- Don't worry about `ws.fs`, `ws.runtime`, or `ws.git` — they ride with
  the parent.
- Pure-value returns (`readFile` as a string, `stat`, `readdir`,
  `git.cli({...})`) carry no stubs; nothing to dispose.

Short-lived single-shot Workers tear the session down with the request,
so this matters most on long-lived isolates that keep grabbing fresh
stubs or on busy `exec` workloads. The full contract is in
[`docs/11_lifecycle.md`](../../docs/11_lifecycle.md#stub-disposal-contract).

To hunt leaks, set `CAPNWEB_TRACK_STUBS=1` and read `stubSnapshot()`
from `@cloudflare/computer-rpc/debug`, or hit `GET /__computerd/stubs`
on a computerd instance.

## Package entrypoints

| Entrypoint | Purpose |
| --- | --- |
| `@cloudflare/computer` | The `Workspace` facade, `workspace.runtime`, stub types, the R2 mount, and proxy classes. |
| `@cloudflare/computer/backends/container` | `CloudflareContainerBackend` and `withWorkspaceContainer`. Pulls in the computerd / capnweb sync plumbing. |
| `@cloudflare/computer/backends/worker-shell` | `WorkerShellBackend` and the bundled just-bash runtime. |
| `@cloudflare/computer/backends/worker-javascript` | `WorkerJavaScriptBackend`, configured libraries, durable imports, `node:fs/promises`, and trusted `ws:git` / `ws:artifacts`. |
| `@cloudflare/computer/tools` | AI SDK tools for agents: `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and optional `exec` and `publish`. |
| `@cloudflare/computer/git` | Opt-in `isomorphic-git` glue for checkouts inside the workspace. |
| `@cloudflare/computer/assets` | `createAssets` — share a workspace file to R2 as a presigned URL. |
| `@cloudflare/computer/artifacts` | `createArtifact` and its CLI, a session-scoped facade over the Cloudflare Artifacts binding. |
| `@cloudflare/computer/observe/cloudflare` | Cloudflare-runtime adapter for the observability hook. |

A consumer that only uses the container backend never imports the worker
subpaths, so unused backend payloads tree-shake away. Wire types shared
with the in-container service live in the sibling package
`@cloudflare/computer-rpc`.

## Advanced

### Multiple backends

A Workspace can carry more than one backend, each registered under a
stable selector `id` (defaulting to `"worker-shell"`,
`"container-shell"`, or `"worker-javascript"`). `runtime.exec` uses the
first backend unless the caller names one:

```ts
const ws = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerShellBackend({ id: "shell", loader: env.LOADER, /* ... */ }),
    new CloudflareContainerBackend({ id: "sandbox", container: () => this, /* ... */ }),
  ],
});

const grep = await ws.runtime.exec("grep -r TODO /workspace");  // default: "shell"
const build = await ws.runtime.exec("npm test", { backend: "sandbox" });
```

Backends connect lazily — the first `exec`, `push`, `pull`, or
`ready(id)` for an id dials it. `ready({ all: true })` pre-warms every
backend, which is handy from an agent's `onStart`. Per-backend sync
cursors are independent, so activity on one never disturbs the other.

A backend that accepts a structured `input` and returns a structured
`value` declares `callable: true` (the worker-javascript backend does).
Passing `input` to a non-callable backend is a clear error rather than a
silent drop.

### Constructing without the mixin

`withWorkspace` is the shortcut. You can also construct a `Workspace`
directly and expose it through a stub yourself:

```ts
const ws = new Workspace({ storage: ctx.storage, backends: [/* ... */] });
await ws.ready();
const stub = ws.stub();  // crosses the Workers-RPC boundary
```

When assigning a workspace to a Think agent's `workspace`, pass
`useThink: true` so Think's compatibility methods are added alongside
`workspace.fs` and `workspace.runtime`.

### Durable pending-sync retries

A command can change backend files and then have its post-command pull
fail; the result exposes `sync: { status: "pending", ... }`. Configure a
`SyncRetryScheduler` on `Workspace` to persist one coalesced retry per
backend, then call `workspace.retryPendingSync(backend)` from your DO's
alarm. Retries use bounded exponential backoff and return `"exhausted"`
after the configured maximum. A container replacement returns `"lost"`
and clears the unrecoverable intent so new work is not blocked. The library
does not own your DO's alarm. See `SyncRetryScheduler`, `SyncRetryIntent`,
and `SyncRetryOptions` in the package exports.

### Observability

Pass an `observer` to the `Workspace` constructor to receive one span
per documented operation (`workspace.connect`, `workspace.sync.push`,
`workspace.sync.pull`, `workspace.runtime.exec.spawn`,
`workspace.fs.<op>`). The `span(name, attributes, run)` shape fits the
Cloudflare runtime's `ctx.tracing`, OpenTelemetry, or a test recorder;
attribute values are restricted to `boolean | number | string`. The
default is a zero-cost no-op, so there's no overhead unless you opt in.
An adapter for the Cloudflare runtime lives at
`@cloudflare/computer/observe/cloudflare`.

## Examples

- [`examples/worker-shell`](../../examples/worker-shell) — the
  worker-shell backend behind a `write` / `read` / `exec` HTTP surface.
  No container.
- [`examples/worker-javascript`](../../examples/worker-javascript) — the
  same shape, running ECMAScript modules instead of shell commands.
- [`examples/container`](../../examples/container) — the container
  backend running `computerd`.
- [`examples/think`](../../examples/think) — a chat agent that uses the
  workspace as its working directory.
- [`examples/tutorial`](../../examples/tutorial) — a step-by-step build:
  write a markdown card on the host, render it to PDF with `pandoc` in
  the container.

## Documentation

The design specification lives under [`docs/`](../../docs/README.md).
Start with [01. VFS](../../docs/01_vfs.md),
[04. Filesystem Interface](../../docs/04_filesystem_interface.md), and
[05. Runtime Interface](../../docs/05_runtime_interface.md). It is
forward-looking — read it for intent, not as a description of the code
today.

## License

MIT. See [`LICENSE`](../../LICENSE).
