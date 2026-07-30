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
SQLite-backed VFS (via `@cloudflare/dofs`) with a pluggable backend
that decides where shell commands run.

Two backends ship today, each on its own sub-path so the large
dependencies they carry can be tree-shaken when you only use one:

- [`@cloudflare/computer/backends/container`](./src/backends/container/) —
  runs the shell inside a Cloudflare Container against a `computerd`
  daemon. Full Linux userland, real binaries, real network. The
  container owns its own SQLite-backed VFS and the package syncs
  the two stores across a capnweb WebSocket.
- [`@cloudflare/computer/backends/worker`](./src/backends/worker/) —
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
- `createAITools` (from `@cloudflare/computer/tools`) — AI SDK
  tools for agents: `read`, `write`, `edit`, `ls`, optional `exec`,
  and optional `publish`. See
  [`docs/09_tool_interface.md`](../../docs/09_tool_interface.md).

## Typical DO-side usage

Container backend:

```ts
import { withWorkspace, WorkspaceProxy } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer }
  from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceProxy };

// `withWorkspace` constructs the Workspace and installs the plumbing
// `getWorkspace` needs — no hand-written stub method. The options
// callback runs after `super(...)`, so it can read `self.ctx`. Compose
// it with `withWorkspaceContainer` when the durable object also owns
// the container binding.
export class ContainerExample extends withWorkspace(
  withWorkspaceContainer(class extends DurableObject<Env> {}),
  (self) => ({
    storage: self.ctx.storage,
    backends: [
      new CloudflareContainerBackend({
        container: () => self,
        workspace: { binding: "ContainerExample", id: self.ctx.id.toString() },
      }),
    ],
  }),
) {}
```

Worker backend:

```ts
import { withWorkspace, WorkspaceServiceProxy } from "@cloudflare/computer";
import { WorkerBackend } from "@cloudflare/computer/backends/worker";
import { DurableObject } from "cloudflare:workers";

export { WorkspaceServiceProxy };

export class ContainerExample extends withWorkspace(
  class extends DurableObject<Env> {},
  (self) => ({
    storage: self.ctx.storage,
    backends: [
      new WorkerBackend({
        loader: self.env.LOADER,
        workspace: { binding: "ContainerExample", id: self.ctx.id.toString() },
        ctx: self.ctx,
      }),
    ],
  }),
) {}
```

Filesystem only — no backend, no shell:

```ts
const ws = new Workspace({ storage: ctx.storage });
await ws.ready();
await ws.fs.writeFile("/notes.md", "hello");
const body = await ws.fs.readFile("/notes.md", "utf8");
// ws.shell throws — there's no backend wired up.
```

Pass `useThink: true` when assigning a workspace to `Think.workspace`.
That adds Think's compatibility methods directly to the local instance
and to clients returned by `getWorkspace()`, while keeping the primary
file API on `workspace.fs`.

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

## Durable pending-sync retries

A command can finish after changing backend files while its post-command pull
fails. The command result reports `sync.status: "pending"`. If you configure a
`SyncRetryScheduler`, Workspace also writes one durable retry intent for that
backend. The library does not use an in-memory timer and cannot own the host
Durable Object's alarm.

The scheduler contract contains only values that a host can persist:

```ts
import {
  type SyncRetryIntent,
  type SyncRetryScheduler,
  Workspace,
} from "@cloudflare/computer";

const RETRY_PREFIX = "workspace:sync-retry:";

class DurableObjectRetryScheduler implements SyncRetryScheduler {
  constructor(private readonly state: DurableObjectState) {}

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    return this.state.storage.get(`${RETRY_PREFIX}${backend}`);
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    // schedule replaces the backend's existing intent, so repeated
    // failures coalesce instead of creating an alarm queue.
    await this.state.storage.put(`${RETRY_PREFIX}${intent.backend}`, intent);

    const intents = await this.state.storage.list<SyncRetryIntent>({
      prefix: RETRY_PREFIX,
    });
    const next = Math.min(...[...intents.values()].map((item) => item.notBefore));
    await this.state.storage.setAlarm(next);
  }

  async clear(backend: string): Promise<void> {
    await this.state.storage.delete(`${RETRY_PREFIX}${backend}`);
  }
}
```

Pass the scheduler to `Workspace` and invoke `retryPendingSync` from the host's
alarm or another durable scheduler:

```ts
export class WorkspaceHost extends DurableObject<Env> {
  readonly scheduler = new DurableObjectRetryScheduler(this.ctx);
  readonly workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [/* ... */],
    retryScheduler: this.scheduler,
    retry: {
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      maxAttempts: 5,
    },
  });

  async alarm(): Promise<void> {
    const intents = await this.ctx.storage.list<SyncRetryIntent>({
      prefix: RETRY_PREFIX,
    });
    const now = Date.now();
    for (const intent of intents.values()) {
      if (intent.notBefore <= now) {
        const result = await this.workspace.retryPendingSync(intent.backend);
        // An exhausted backend keeps its final intent in storage with a
        // past-due notBefore. Clear it here so it stops driving the alarm;
        // otherwise the wake-up fires immediately and forever. Inspect or
        // alert before clearing if you need to surface the exhaustion.
        if (result.status === "exhausted") {
          await this.scheduler.clear(intent.backend);
        }
      }
    }

    const remaining = await this.ctx.storage.list<SyncRetryIntent>({
      prefix: RETRY_PREFIX,
    });
    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(
        Math.min(...[...remaining.values()].map((item) => item.notBefore)),
      );
    }
  }
}
```

`retryPendingSync(backend?)` enters the same per-backend FIFO as commands,
`push`, and `pull`. It resumes `pullOnce` from the cursor already persisted in
SQLite. Success clears the intent. Failure replaces it with the next bounded
exponential-backoff attempt. Once `maxAttempts` fails, the final intent stays
in storage and the method returns `status: "exhausted"`; the host can inspect,
alert on, or explicitly clear it. Calling the method with no pending intent
returns `status: "idle"`.

## Worker-side consumption

```ts
import { getWorkspace } from "@cloudflare/computer";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.ContainerExample.idFromName("user-123");
    using ws = await getWorkspace(env.ContainerExample.get(id));

    await ws.fs.writeFile("/notes.md", "hello");
    using handle = await ws.shell.exec("ls /workspace", { encoding: "utf8" });
    const { exitCode, stdout, sync } = await handle.result();
    if (sync.status === "pending") {
      console.warn("command completed before its filesystem changes synced", sync.error);
    }

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

`getWorkspace(stub)` calls the accessor the `withWorkspace` mixin
installed on the durable object, then wraps the returned stub in a
Worker-side client. Called with the durable object itself
(`getWorkspace(this)`), it returns the same client backed by the
in-isolate Workspace, so the surface is identical in both places. The
client mirrors the stub surface (`fs`, `git`, `shell`, `artifacts`,
`assets`); the only difference is that
`shell.exec` also accepts a tagged template, covered next.

### Building commands safely

`shell.exec` runs one command string through `/bin/sh -c` in the
container. Pasting a path or any other value straight into that string
is a shell-injection risk: a value like `x; rm -rf /` breaks out of its
argument. Call `exec` as a tagged template and interpolated values are
escaped for you:

```ts
const file = "my notes.md";
const out = await (await ws.shell.exec`cat ${file}`).result(); // cat 'my notes.md'
```

The tagged-template form defaults to string (`utf8`) output, since a
caller reaching for it almost always wants text back.

The plain `exec(command, options)` form is unchanged. Use it when you
need `cwd` or `backend`, and wrap an interpolated command in the `sh`
tag to escape it:

```ts
import { sh } from "@cloudflare/computer";

await ws.shell.exec(sh`cat ${file}`, { cwd: "/workspace" });
await ws.shell.exec("npm test", { cwd: "/workspace", encoding: "utf8" });
```

The plain form defaults to `Uint8Array` output; pass
`{ encoding: "utf8" }` for a string.

`sh` quotes strings and numbers, quotes arrays element-by-element, and
leaves the static template parts alone — they're the trusted command.
When you really do mean shell syntax, wrap the value in `{ raw: "..." }`
to opt out of escaping for that one value:

```ts
await ws.shell.exec(sh`ls ${dir} ${{ raw: "| wc -l" }}`);
```

The escaping has to run in the caller, not on the durable-object side:
when the command crosses Workers RPC, a tagged template's `.raw`
property doesn't survive structured clone, so the wrapper (and `sh`)
collapse the template to a finished string before the call. The remote
stub's `exec` rejects a raw tagged-template call so the unescaped path
fails loudly. `shellQuote` is exported too, for the rare case where
you need to quote a single argument outside a template.

### Reattaching to a run

A command outlives the request that started it. Every handle carries
the run's `id`, and `shell.get(id)` reattaches to it from a later
request:

```ts
using ws = await getWorkspace(env.ContainerExample.get(id));

// First request: start a long install and remember its id.
using started = await ws.shell.exec("npm install", { id: "install-1" });

// Later request, new handle, same run. `resume` picks where the
// replayed event stream starts: "tail" for live events only, "full"
// (the default) for everything the runner still holds, or a sequence
// number to resume after.
using again = await ws.shell.get("install-1", { encoding: "utf8", resume: "tail" });
const { exitCode } = await again.result();
```

The client mints an id when the caller doesn't pass one, so
`handle.id` is available either way. Reattach doesn't run the
push/pull bracket — it joins a run already in flight — so its sync
counts cover only what lands after the reattach.

A run streams to one reader at a time. Dropping a handle — the `using`
above, or an explicit `cancel()` — hands the stream back, which is what
lets the next request reattach. Reattaching while an earlier handle is
still reading is refused.

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
- `workspace.shell.exec` — the full exec bracket from the
  `WorkspaceStub`. Contains `workspace.sync.push`,
  `workspace.shell.exec.spawn`, and `workspace.sync.pull` as nested
  children. Tagged with `workspace.shell.exit_code`,
  `workspace.shell.pushed`, `workspace.shell.pulled`,
  `workspace.shell.skipped`, and `workspace.shell.sync.status`. Pending
  pulls also set `workspace.shell.sync.error` to the same bounded,
  credential-redacted error returned in `ExecResult.sync`.
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
via `stubSnapshot()` from `@cloudflare/computer-rpc/debug`, or
hit `GET /__computerd/stubs` on a computerd instance. The soak scripts at
[`script/computerd-stub-soak.mjs`](../../script/computerd-stub-soak.mjs) and
[`tests/stub-soak.test.ts`](./tests/stub-soak.test.ts) exercise both
boundaries.
