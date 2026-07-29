# 12. Worker backend

> [!NOTE]
> This doc reflects shipped code in
> `packages/computer/src/backends/worker/`. The example deployment
> lives at `examples/worker/`.

The worker backend is the second `WorkspaceBackend` shape the
package ships. It pairs a Workspace with a
[just-bash](https://github.com/vercel-labs/just-bash) shell running
in a Dynamic Worker minted through `env.LOADER`. The shell reaches
the host workspace over Workers RPC, so there is no second store
and no sync round trip; the host Durable Object's SQLite is the
only authoritative state.

Import via the sub-path so the bundled just-bash payload tree-shakes
out of consumers that don't use it:

```ts
import { WorkerBackend } from "@cloudflare/computer/backends/worker";
```

## When to reach for it

The container backend (`@cloudflare/computer/backends/container`)
gives you a real Linux environment with arbitrary binaries on
`$PATH`, network, and a full POSIX filesystem. It costs a container
per session and a real roundtrip on every filesystem op.

The worker backend trades the real environment for a Workers
isolate that boots instantly, scales out cheaply, and has no
container lifecycle. The shell is the just-bash interpreter; the
supported command set is broad (`cat`, `grep`, `awk`, `sed`, `jq`,
`sort`, optional Python and JavaScript via WASM) but not the full
Linux userland. Filesystem operations forward into the same
SQLite store as the container backend, so the storage shape, mount
rules, and read-only enforcement are unchanged.

Reach for the worker backend when:

- The agent only needs textual shell tooling — read, search,
  transform, summarize. Not when it needs to compile, install
  packages, or run a browser.
- You want isolation without a container. A runaway Bash run in
  one workspace can OOM its Dynamic Worker isolate without
  affecting the host DO.
- You're sensitive to the per-session container cost.

Reach for the container backend when the agent runs `git`, `npm`,
a real language runtime, or anything else that wants a real
kernel under it.

## Wire shape

```
agent code
  │  Workers RPC
  ▼
host DO ─── Workspace ─── WorkerBackend
                              │
                              │  env.LOADER.get(loaderId, codeCallback)
                              │    .getEntrypoint("ShellWorker")
                              ▼
                       Dynamic Worker (ShellWorker)
                       WorkerEntrypoint with exec / getExec /
                       killExec RPC methods
                              │
                              │  env.HOST.getWorkspace() per exec
                              ▼
                       new Bash({ fs: WorkspaceFsAdapter(ws.fs) })
                              │
                              │  every fs RPC the shell makes lands
                              │  in the host DO's own request context
                              ▼
                       back to host DO's SQLite
```

The Worker Loader caches the Dynamic Worker isolate by id. The
default id is `workspace-shell:${workspace.id}` — one isolate per
workspace, so concurrent execs in the same workspace share a warm
isolate, and a runaway Bash run in one workspace can't touch
another workspace's shell.

`globalOutbound: null` on the Dynamic Worker blocks `fetch()` and
`connect()` from inside the shell. The only path out of the
isolate is back through the host DO over `env.HOST`.

## Built-in custom commands

The worker backend registers two just-bash custom commands on every
exec:

- `git ...` forwards to the host workspace's `workspace.git.cli(...)`.
- `assets publish <path> [<expiry>]` forwards to the host
  workspace's configured assets publisher and prints the share URL
  to stdout.

`assets publish` accepts an absolute path or a path relative to the
current working directory. The optional expiry defaults to one hour;
a bare number is milliseconds, and `ms`, `s`, `m`, and `h` suffixes
are accepted (`30000`, `30s`, `5m`, `2h`). If the Workspace was not
constructed with an assets client, the command exits 1 with a clear
message.

The Dynamic Worker never receives the R2 bucket binding or signing
secrets. The host Durable Object configures the Workspace with an
assets client, and the command reaches that host-side capability over
the same `env.HOST.getWorkspace()` loopback as filesystem and git
calls.

## Why a loopback proxy

The natural impulse is to hand the Dynamic Worker the host DO's
`DurableObjectNamespace` directly in its `env`. That fails:
values passed through the Worker Loader's `env` go through
structured clone, and a raw `DurableObjectNamespace` doesn't
survive that.

`WorkspaceServiceProxy` (in `@cloudflare/computer`) is a tiny
`WorkerEntrypoint` whose `getWorkspace()` method does the
namespace lookup on the host side. The backend mints a stub
through `ctx.exports.WorkspaceServiceProxy({ props: { binding,
id } })`; the resulting Fetcher *does* survive structured clone
because the runtime serializes it as a binding reference rather
than a value. The shell calls `env.HOST.getWorkspace()` per exec
and reaches back into the host DO through a normal Workers RPC
hop.

A per-call lookup also matters for I/O context: every filesystem
RPC the shell makes lands inside the host DO's own request
context, where the DO's storage handles are valid. An earlier
attempt at handing the shell a long-lived `WorkspaceFilesystemStub`
through `env` hit workerd's cross-request I/O guard immediately —
the shell's request context and the DO's request context aren't
the same.

## Push and pull

`BackendHandle.sync` is `"none"`. With a single authoritative
store there's nothing to ship or fetch; `Workspace.push` and
`Workspace.pull` short-circuit on the bit and the reconcile pass
on connect is skipped. The shell exec bracket still calls them so
the surface stays uniform — every `ExecResult.pushed`, `pulled`,
and `skipped` is empty.

## Event stream framing

`ShellWorker.exec` returns `{ id, events:
ReadableStream<Uint8Array> }`. The byte stream is newline-
delimited JSON, one `ExecEvent` per line. Workers RPC carries
byte streams natively; the JSON-framed log is the lowest-friction
shape across the isolate hop.

The backend decodes the frames into structured `ExecEvent` values
and re-encodes string payloads (`stdout` / `stderr`) into
`Uint8Array` so the existing `WorkspaceShell` utf8 decoder
transforms in `packages/computer/src/shell.ts` see the shape
they already handle.

## Fetcher factory escape hatch

`WorkerBackend` is source-agnostic. The common case takes
`{ loader, workspace, ctx }` and builds the loader callback
itself. For deployments that need a different Fetcher source — a
Workers service binding, a Workers-for-Platforms dispatch
namespace, a fake in tests — pass `fetcher: () => unknown |
Promise<unknown>` instead. The factory is consulted once on
`connect()`; the resolved Fetcher is held for the life of the
handle.

## Known fidelity gaps

- **Single-chunk stdout/stderr.** just-bash returns the full
  stdout and stderr at the end of a run rather than streaming
  chunks. `ShellWorker.exec` emits one stdout event (when
  non-empty), one stderr event (when non-empty), and one exit
  event. Live streaming would need a fork of just-bash or a
  wrapper writer.
- **No hard links, no `utimes`.** The adapter throws `ENOSYS` on
  `link` (the store has no hard-link model) and no-ops on
  `utimes` (no atime column). `chmod`, `symlink`, `readlink`,
  and `lstat` all work end-to-end against the DO's store.
- **No cross-request reattach.** `ShellWorker.getExec` always
  returns ENOENT; `killExec` is a no-op. Each exec is scoped to
  its own call. The previous in-isolate event log shape didn't
  survive the move to per-call workspace stubs (each exec
  fetches its own stub through `env.HOST.getWorkspace()`).
- **PATH-walk diagnostics in wrangler dev.** just-bash probes
  every directory on `$PATH` for every command name. Each miss
  resolves a rejected RPC promise that workerd's rpc layer
  flags as "Uncaught" in the dev log, even though just-bash
  catches the rejection locally. The noise is cosmetic;
  `exec` still returns the correct result.

## Custom commands

The shell isolate registers built-in `git` and `artifacts` commands
that forward through the `WorkspaceStub` returned by
`getWorkspace()`: `git` calls `workspace.git.cli(...)`, and
`artifacts` calls `workspace.artifacts.cli(...)`. The `artifacts`
command also bridges the two: its `create` shorthand registers a git
remote, so the command hands the artifacts CLI a `remoteAdd` closure
backed by the same `workspace.git.cli(...)`. The artifacts package
owns no git of its own; the bridge lives at the backend wiring layer.
`ShellWorker` still exposes an `extraCommands(ws)` hook for layering
project-specific commands onto the same Bash instance. The hook runs
once per `exec` with the live host stub the shell already reached, so
a command shares that stub's lifetime without refetching.

A host durable object wires the Artifacts command by passing the
binding to `Workspace`:

```ts
export class MyAgent extends DurableObject<Env> {
  #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      sessionId: ctx.id.toString(),
      artifacts: { binding: env.ARTIFACTS },
      backends: [new WorkerBackend(/* ... */)],
    });
  }
}
```

With the binding declared in Wrangler:

```jsonc
{
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]
}
```

`artifacts repo list` inside `bash.exec` then forwards to the
client's `cli(...)`. The shell isolate has no network of its
own; the binding call lands host-side, the same way
network-bound `git` subcommands do. See
[`docs/15_artifacts_interface.md`](./15_artifacts_interface.md).

## Example

`examples/worker/` is a single wrangler project that mirrors
`examples/container/` beat for beat:

- One `wrangler.jsonc` with the Durable Object, an R2 mount at
  `/workspace/r2`, and a `worker_loaders` binding named `LOADER`.
- `src/index.ts` holds the DO and the HTTP surface (the
  `/c/<name>/file/...` and `/c/<name>/exec` routes the container
  example also exposes).
- No Dockerfile, no build script. The shell bundle ships with
  `@cloudflare/computer/backends/worker` as `SHELL_MODULES`
  (a record of module name → source covering the entry plus
  every code-split chunk); the backend hands the whole record
  to the Loader callback itself.

The DO's backend wiring fits in three lines:

```ts
new WorkerBackend({
  loader: env.LOADER,
  workspace: { binding: "ContainerExample", id: ctx.id.toString() },
  ctx,
})
```

Run with `npm run dev --workspace @example/computer-worker`.
The same `curl` recipes from the container example work without
changes.
