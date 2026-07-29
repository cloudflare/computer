# `@cloudflare/workspace`

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](docs/) is forward-looking — read it for
> intent, not as description of the code today.

Durable Object-side facade for a Cloudflare Workspace. Pairs a local
SQLite-backed VFS (via `@cloudflare/dofs`) with a pluggable backend
that decides where shell commands run.

Two backends ship today, each on its own sub-path so the large
dependencies they carry can be tree-shaken when you only use one:

- [`@cloudflare/workspace/backends/container`](./src/backends/container/) —
  runs the shell inside a Cloudflare Container against a `wsd`
  daemon. Full Linux userland, real binaries, real network. The
  container owns its own SQLite-backed VFS and the package syncs
  the two stores across a capnweb WebSocket.
- [`@cloudflare/workspace/backends/worker`](./src/backends/worker/) —
  runs the shell as [just-bash](https://github.com/vercel-labs/just-bash)
  inside a Dynamic Worker minted through `env.LOADER`. Every
  filesystem operation forwards back to the same Durable Object;
  no second store, no sync round trip. See
  [`docs/12_worker_backend.md`](../../docs/12_worker_backend.md) and
  `examples/worker/`.

A backend can declare `sync: "none"` on the handle it returns to
opt out of the push/pull bracket entirely — the worker backend
does this because its shell shares the host store directly. The
bracket still runs around `shell.exec` so the surface stays
uniform; the counts are just always zero.

## Public surface

- `Workspace` — the host-side facade. Owns the local store, the
  backend handle, and the push/pull bracket.
- `WorkspaceStub` — what `workspace.stub()` returns, designed to
  cross the Workers-RPC boundary into another Worker or DO.
- `WorkspaceShell` / `ExecHandle` — the command-execution half of
  the API. Throws a clear error if the Workspace was constructed
  without a backend.
- `workspace.git` — a typed git client backed by
  `isomorphic-git` against the local SQLite VFS. Surfaces both a
  TypeScript API (`workspace.git.clone({ url })`) and an
  argv-driven entry point (`workspace.git.cli({ argv })`). The
  worker backend's shell exposes the same dispatcher through a
  built-in `git` custom command. See
  [`docs/13_git_interface.md`](../../docs/13_git_interface.md).
- `createAssets` (from `@cloudflare/workspace/assets`) — `publish` a
  workspace file to an R2 bucket and get back a presigned URL.
  Binds the workspace and bucket once, like `workspace.git`. When
  attached through `WorkspaceOptions.assets`, the worker backend's
  shell also exposes `assets publish <path> [<expiry>]`. See
  [`docs/14_assets_interface.md`](../../docs/14_assets_interface.md).
- `createArtifact(binding, sessionId)` — a session-scoped facade
  over the [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
  Workers binding, on the `@cloudflare/workspace/artifacts`
  subpath. Every repository name is implicitly prefixed with the
  session id, so one namespace hosts many isolated sessions. Like
  git, it surfaces both a typed API and an argv CLI
  (`artifacts.cli({ argv })`); when `Workspace` is configured with
  an Artifacts binding, the worker backend exposes the same CLI as
  an `artifacts` custom command. See
  [`docs/15_artifacts_interface.md`](../../docs/15_artifacts_interface.md).
- `createAITools` (from `@cloudflare/workspace/tools`) — AI SDK
  tools for agents: `read`, `write`, `edit`, `ls`, optional `exec`,
  and optional `publish`. See
  [`docs/09_tool_interface.md`](../../docs/09_tool_interface.md).

## Typical DO-side usage

Container backend:

```ts
import { Workspace, WorkspaceProxy } from "@cloudflare/workspace";
import { CloudflareContainerBackend, withWorkspaceContainer }
  from "@cloudflare/workspace/backends/container";
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
import { Workspace, WorkspaceServiceProxy } from "@cloudflare/workspace";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceServiceProxy };

export class ContainerExample extends DurableObject<Env> {
  #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerBackend({
        loader: env.LOADER,
        workspace: { binding: "ContainerExample", id: this.ctx.id.toString() },
        ctx,
      }),
    ],
  });

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }
}
```

Filesystem only — no backend, no shell:

```ts
const ws = new Workspace({ storage: ctx.storage });
await ws.ready();
await ws.fs.writeFile("/notes.md", "hello");
const body = await ws.fs.readFile("/notes.md", "utf8");
// ws.shell throws — there's no backend wired up.
```

Git, also without a backend:

```ts
const ws = new Workspace({
  storage: ctx.storage,
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
import { createArtifact } from "@cloudflare/workspace/artifacts";

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
registers under a stable `id` (defaulting to the backend's
diagnostic kind — `"worker"`, `"cloudflare-container"` — so
single-backend setups stay terse). `shell.exec` picks the
default (the first backend in the list) unless the caller
names a backend through `ExecOptions.backend`. Per-backend
sync cursors live in dofs's `_vfs_watermark` table keyed by
the same id; a push or pull against one backend never disturbs
the other's cursors.

```ts
const workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerBackend({
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
const grep = await ws.shell.exec("grep -r TODO /workspace");

// Explicit: route a heavy build to the container.
const build = await ws.shell.exec("npm test", { backend: "sandbox" });
```

Backends connect lazily — the first `exec` (or `push` /
`pull` / `ready(id)`) for an id dials it. `ready({ all: true })`
pre-warms every configured backend in parallel; useful from an
agent's `onStart`. `Workspace.push(id?)` and
`Workspace.pull(id?)` target a single backend, defaulting to
the first one.

A workspace with two backends that both write into
`/workspace` has no global ordering between them; see
[`docs/05_shell_interface.md`](../../docs/05_shell_interface.md)
for the caveat.

## Worker-side consumption

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.ContainerExample.idFromName("user-123");
    using ws = await env.ContainerExample.get(id).getWorkspace();

    await ws.fs.writeFile("/notes.md", "hello");
    using handle = await ws.shell.exec("ls /workspace");
    const { exitCode, stdout } = await handle.result();

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

## Observability

The package emits one span per documented operation through an optional
observer hook. Pass an observer to the `Workspace` constructor:

```ts
import { Workspace, type WorkspaceObserver } from "@cloudflare/workspace";

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
- `workspace.shell.exec` — the full exec bracket from the
  `WorkspaceStub`. Contains `workspace.sync.push`,
  `workspace.shell.exec.spawn`, and `workspace.sync.pull` as nested
  children. Tagged with `workspace.shell.exit_code`,
  `workspace.shell.pushed`, `workspace.shell.pulled`, and
  `workspace.shell.skipped`.
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
DO ↔ wsd over capnweb), undisposed stubs accumulate on the peer
side until the session ends. The worker backend uses Workers RPC
over an isolate boundary rather than capnweb, but the disposal
discipline is the same.

The minimum a caller needs to know:

- `using` the value returned from `env.WSD.get(id).getWorkspace()`.
- `using` the handle returned from `ws.shell.exec(...)`.
- Don't worry about `ws.fs`, `ws.shell`, or `ws.git` — those are
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
via `stubSnapshot()` from `@cloudflare/workspace-rpc/debug`, or
hit `GET /__wsd/stubs` on a wsd instance. The soak scripts at
[`script/wsd-stub-soak.mjs`](../../script/wsd-stub-soak.mjs) and
[`tests/stub-soak.test.ts`](./tests/stub-soak.test.ts) exercise both
boundaries.
