# `@cloudflare/computer`

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](docs/) is forward-looking — read it for
> intent, not as description of the code today.

Durable Object-side facade for Cloudflare Computer. Pairs a local
SQLite-backed VFS (via `@cloudflare/dofs`) with pluggable execution
backends selected through `workspace.runtime.exec()`.

Three backends ship today on tree-shakeable subpaths:

- [`@cloudflare/computer/backends/container`](./src/backends/container/) —
  runs the shell inside a Cloudflare Container against a `computerd`
  daemon. Full Linux userland, real binaries, real network. The
  container owns its own SQLite-backed VFS and the package syncs
  the two stores across a capnweb WebSocket.
- [`@cloudflare/computer/backends/worker-shell`](./src/backends/worker-shell/) —
  runs the shell as [just-bash](https://github.com/vercel-labs/just-bash)
  inside a Dynamic Worker minted through `env.LOADER`. Every
  filesystem operation forwards back to the same Durable Object;
  no second store, no sync round trip. See
  [`docs/12_worker_backend.md`](../../docs/12_worker_backend.md) and
  `examples/worker-shell/`.
- [`@cloudflare/computer/backends/worker-javascript`](./src/backends/worker-javascript/) —
  executes ECMAScript modules in fresh Dynamic Workers with structured
  input/results, durable relative imports, configured libraries, durable
  `node:fs/promises`, and trusted `ws:git` / `ws:artifacts` modules. See
  [`docs/17_isolate_javascript.md`](../../docs/17_isolate_javascript.md).

The worker-JavaScript backend runs after `runtime.exec()` returns. Pass
`waitUntil: ctx.waitUntil.bind(ctx)` to `Workspace` so completion remains
attached to the Durable Object event. The backend refuses to connect without
this lifecycle hook. It admits one execution at a time by default and bounds
completed execution retention by time and count.

A backend can declare `sync: "none"` on the handle it returns to
opt out of the push/pull bracket entirely — the worker backend
does this because its shell shares the host store directly. The
bracket still runs around `runtime.exec` so the surface stays
uniform; the counts are just always zero.

## Public surface

- `Workspace` — the host-side facade. Owns the local store, the
  backend handle, and the push/pull bracket.
- `WorkspaceStub` — what `workspace.stub()` returns, designed to
  cross the Workers-RPC boundary into another Worker or DO.
- `workspace.runtime` / `WorkspaceRuntimeStub` — the single execution
  surface: `exec`, `getExec`, `killExec`, and `disposeExec`. The selected
  backend defines the source language. JavaScript results may include a
  structured `value`; command backends return stdout/stderr and an exit code.
- `workspace.git` — an opt-in typed git client backed by
  `isomorphic-git` against the local SQLite VFS. Pass
  `createGitClient()` from `@cloudflare/computer/git` as
  `WorkspaceOptions.git` to enable both the TypeScript API
  (`workspace.git.clone({ url })`) and the argv-driven entry point
  (`workspace.git.cli({ argv })`). The git subpath bundles
  `isomorphic-git` lazily and replaces its `pako` dependency with
  the Workers `node:zlib` implementation, so the default package
  graph stays free of git. The worker backend's shell exposes the
  same dispatcher through a built-in `git` custom command when git
  is configured. See
  [`docs/13_git_interface.md`](../../docs/13_git_interface.md).
- `createAssets` (from `@cloudflare/computer/assets`) — `share` a
  workspace file to an R2 bucket and get back a presigned URL.
  Binds the workspace and bucket once, like `workspace.git`. When
  attached through `WorkspaceOptions.assets`, the worker backend's
  shell also exposes `assets publish <path> [<expiry>]`. See
  [`docs/14_assets_interface.md`](../../docs/14_assets_interface.md).
- `createArtifact(binding, sessionId)` — a session-scoped facade
  over the [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
  Workers binding, on the `@cloudflare/computer/artifacts`
  subpath. Every repository name is implicitly prefixed with the
  session id, so one namespace hosts many isolated sessions. Like
  git, it surfaces both a typed API and an argv CLI
  (`artifacts.cli({ argv })`); when `Workspace` is configured with
  an Artifacts binding, the worker backend exposes the same CLI as
  an `artifacts` custom command. See
  [`docs/15_artifacts_interface.md`](../../docs/15_artifacts_interface.md).

## Typical DO-side usage

Container backend:

```ts
import { Workspace, WorkspaceProxy } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer }
  from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceProxy };

export class ContainerExample extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new CloudflareContainerBackend({
        container: () => this,
        workspace: { binding: "ContainerExample", id: this.ctx.id.toString() },
      }),
    ],
  });

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  override fetch(req: Request) { return this.#workspace; /* see example */ }
}
```

Worker backend:

```ts
import { Workspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceServiceProxy };

export class WorkerExample extends DurableObject<Env> {
  #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerShellBackend({
        loader: this.env.LOADER,
        workspace: { binding: "WorkerExample", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
    ],
  });

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }
}
```

Filesystem only — no execution backend:

```ts
const ws = new Workspace({ storage: ctx.storage });
await ws.ready();
await ws.fs.writeFile("/notes.md", "hello");
const body = await ws.fs.readFile("/notes.md", "utf8");
// ws.runtime throws — there's no backend wired up.
```

Pass `useThink: true` when assigning a workspace to `Think.workspace`.
That adds Think's compatibility methods directly to the local instance
and to clients returned by `getWorkspace()`, while keeping `workspace.fs`
and `workspace.runtime` as the primary surfaces.

Git, also without a backend:

```ts
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
const log = await ws.git.log({ depth: 1 });
```

Every `workspace.git` operation reads and writes through the
local store; no backend or shell is required. See the doc
above for the full method surface, error hierarchy, and CLI
shape.

## Artifacts

`createArtifact(binding, sessionId)` wraps the Cloudflare
Artifacts Workers binding in a session-scoped client. Names go
in and out local; the session id is added as a prefix on the
way to the namespace and stripped on the way back.

```ts
import { createArtifact } from "@cloudflare/computer/artifacts";

const artifacts = createArtifact(env.ARTIFACTS, agentId);

const repo = await artifacts.create("build-cache", {
  description: "CI artifacts for this agent",
});
// repo.name -> "build-cache"; stored as `${agentId}__build-cache`.

const token = await artifacts.createToken("build-cache", "read", 3600);
// token.plaintext is a git token — a secret, shown once.

const mine = await artifacts.list();
// Only this session's repos, names unscoped.
```

The binding (`Artifacts`) and its result shapes are the global
types from a Workers project's `@cloudflare/workers-types` setup;
the facade adds session scoping on top rather than redeclaring the
wire protocol. Pass the binding to `Workspace` as
`artifacts: { binding: env.ARTIFACTS }` to expose the same surface as
an in-shell `artifacts` command. See
[`docs/15_artifacts_interface.md`](../../docs/15_artifacts_interface.md).

## Multiple backends per workspace

A Workspace can carry more than one backend. Each backend
registers under a stable selector `id` (defaulting to
`"worker-shell"`, `"container-shell"`, or `"worker-javascript"`; this is intentionally separate from the diagnostic `type`).
`runtime.exec` picks the default (the first backend in the list)
unless the caller names one through `WorkspaceRuntimeExecOptions.backend`. Per-backend
sync cursors live in dofs's `_vfs_watermark` table keyed by
the same id; a push or pull against one backend never disturbs
the other's cursors.

A backend also declares whether it is `callable`. A callable
backend accepts a structured `input` value on `runtime.exec` and
returns a structured `value` on the result; the
`worker-javascript` backend sets `callable: true` because it runs
a module that takes an argument and produces a return value. This
is independent of the backend kind — a shell backend that coerced
JSON into argv and stdin and parsed stdout back into a value could
declare itself callable too. When a caller passes `input` to a
backend that is not callable, the runtime rejects the call with a
clear error rather than silently dropping the value, so a custom
backend must set `callable: true` before it can receive `input`.

```ts
const workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerShellBackend({
      id: "shell",
      loader: env.LOADER,
      workspace: { binding: "AgentDO", id: ctx.id.toString() },
      ctx,
    }),
    new CloudflareContainerBackend({
      id: "sandbox",
      container: () => this,
      workspace: { binding: "AgentDO", id: ctx.id.toString() },
    }),
  ],
});

// Default: the first backend in the list runs the command.
const grep = await ws.runtime.exec("grep -r TODO /workspace");

// Explicit: route a heavy build to the container.
const build = await ws.runtime.exec("npm test", { backend: "sandbox" });
```

Backends connect lazily — the first `exec` (or `push` /
`pull` / `ready(id)`) for an id dials it. `ready({ all: true })`
pre-warms every configured backend in parallel; useful from an
agent's `onStart`. `Workspace.push(id?)` and
`Workspace.pull(id?)` target a single backend, defaulting to
the first one.

A workspace with two backends that both write into
`/workspace` has no global ordering between them; see
[`docs/05_runtime_interface.md`](../../docs/05_runtime_interface.md)
for the caveat.

## Durable pending-sync retries

A command can finish after changing backend files while its post-command pull fails. The command result exposes `sync: { status: "pending", error, ... }`. Configure a `SyncRetryScheduler` on `Workspace` to persist one coalesced retry intent per backend, then call `workspace.retryPendingSync(backend)` from the owning Durable Object's alarm or another durable scheduler. Retries share the same per-backend mutation FIFO as `push`, `pull`, and command brackets, use bounded exponential backoff, clear their intent after success, and return `"exhausted"` after the configured maximum. The library intentionally does not own the host Durable Object's alarm.

See `SyncRetryScheduler`, `SyncRetryIntent`, and `SyncRetryOptions` in the root package exports for the persistence contract.

## Worker-side consumption

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.ContainerExample.idFromName("user-123");
    using ws = await env.ContainerExample.get(id).getWorkspace();

    await ws.fs.writeFile("/notes.md", "hello");
    using handle = await ws.runtime.exec("ls /workspace");
    const { exitCode, stdout } = await handle.result();

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

## Observability

The package emits one span per documented operation through an optional
observer hook. Pass an observer to the `Workspace` constructor:

```ts
import { Workspace, type WorkspaceObserver } from "@cloudflare/computer";

const observer: WorkspaceObserver = {
  async span(name, attributes, run) {
    // Wrap `run` however your tracing backend wants. The Cloudflare
    // runtime, OpenTelemetry, and a plain console.log adapter all fit
    // the same shape.
    return run({ setAttribute: () => {} });
  },
};

const ws = new Workspace({
  storage: this.ctx.storage,
  backends: [...],
  observer,
});
```

The observer's `span(name, attributes, run)` wraps each operation. It
starts a span, runs the callback, and ends the span when the callback
returns or its promise settles. Errors thrown by the work record
`error.name` and `error.message` and propagate.

The span names the package emits today:

- `workspace.connect` — one per `connect()` attempt against a single
  backend. Tagged with `workspace.backend.id`.
- `workspace.sync.push` / `workspace.sync.pull` — one per sync call.
  Tagged with the entry counts (`workspace.sync.pushed`,
  `workspace.sync.applied`, `workspace.sync.skipped`).
- `workspace.runtime.exec.spawn` — command-backend dispatch. Command
  synchronization emits separate `workspace.sync.push` and
  `workspace.sync.pull` spans. Module-runtime instrumentation currently
  records backend connection and capability filesystem operations; a
  unified parent execution span is planned.
- `workspace.fs.<op>` — one per filesystem call routed through the
  stub (`readFile`, `writeFile`, `stat`, `readdir`, `find`, `ls`,
  `grep`, `mkdir`, `rm`). Tagged with `workspace.fs.path` and, where
  meaningful, `workspace.fs.entries` or `workspace.fs.matches`.

Attribute values are restricted to `boolean | number | string` so the
same observer shape works against the Cloudflare runtime's built-in
`ctx.tracing.enterSpan(...)` API, OpenTelemetry, or a recording test
observer. Adapter packages for the Cloudflare runtime and for
OpenTelemetry are forthcoming.

The default is a no-op observer with no allocation or async overhead
beyond what the callback itself does, so the package has no
observability cost when callers do not opt in.

## Stub disposal

capnweb does not garbage-collect remote stubs. On the long-lived
sessions this package depends on (Worker ↔ DO over Workers RPC,
DO ↔ computerd over capnweb), undisposed stubs accumulate on the peer
side until the session ends. The worker backend uses Workers RPC
over an isolate boundary rather than capnweb, but the disposal
discipline is the same.

The minimum a caller needs to know:

- `using` the value returned from `env.COMPUTERD.get(id).getWorkspace()`.
- `using` the handle returned from `ws.runtime.exec(...)`.
- Don't worry about `ws.fs`, `ws.runtime`, or `ws.git` — those are
  property accessors that ride with the parent.
- Pure-value returns (`readFile` as a string, `stat`, `readdir`,
  `git.cli({...})`, etc.) carry no stubs; nothing to dispose.

Short-lived single-shot Workers (one `getWorkspace()`, a few calls,
return a response) tear the session down with the request, so the
discipline matters most on long-lived isolates that keep grabbing
fresh `WorkspaceStub`s or on busy `exec` workloads inside a single
request.

The full contract — including the boundary between the driver code
and direct streaming callers, and how it interacts with hibernation
and reconnect — is in [`docs/11_lifecycle.md`](../../docs/11_lifecycle.md#stub-disposal-contract).

Leak discovery: set `CAPNWEB_TRACK_STUBS=1` and read the snapshot
via `stubSnapshot()` from `@cloudflare/computer-rpc/debug`, or
hit `GET /__computerd/stubs` on a computerd instance. The soak scripts at
[`script/computerd-stub-soak.mjs`](../../script/computerd-stub-soak.mjs) and
[`tests/stub-soak.test.ts`](./tests/stub-soak.test.ts) exercise both
boundaries.
