# 12. Worker backend

> [!NOTE]
> This doc reflects shipped code in
> `packages/computer/src/backends/worker-shell/`. The example deployment
> lives at `examples/worker-shell/`.

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
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
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
`sort`) but not the full Linux userland. JavaScript modules run through the
[`worker-javascript` backend](./17_isolate_javascript.md), not through just-bash's
Node-only language commands. Filesystem operations forward into the same
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

Reach for the container backend when the agent runs `npm`, a real language runtime, native binaries, or anything else that needs a real kernel. Prefer the worker backend's host-forwarded `git` command for supported Git operations; use the container only for Git behavior that requires its native environment.

## Wire shape

```
agent code
  │  Workers RPC
  ▼
host DO ─── Workspace ─── WorkerShellBackend
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
on connect is skipped. The exec sync bracket still calls them so
the surface stays uniform — the pushed, pulled, and skipped counts
on the runtime result are empty.

## Event stream framing

`ShellWorker.exec` returns `{ id, events:
ReadableStream<Uint8Array> }`. The byte stream is newline-
delimited JSON, one `ExecEvent` per line. Workers RPC carries
byte streams natively; the JSON-framed log is the lowest-friction
shape across the isolate hop.

The backend decodes the frames into structured `ExecEvent` values
and re-encodes string payloads (`stdout` / `stderr`) into
`Uint8Array` so the runtime's utf8 decoder transforms, which
accumulate the result from raw events, see the shape they already
handle.

## Fetcher factory escape hatch

`WorkerShellBackend` is source-agnostic. The common case takes
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
      backends: [new WorkerShellBackend(/* ... */)],
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

`examples/worker-shell/` is a single wrangler project that mirrors
`examples/container/` beat for beat:

- One `wrangler.jsonc` with the Durable Object, an R2 mount at
  `/workspace/r2`, and a `worker_loaders` binding named `LOADER`.
- `src/index.ts` holds the DO and the HTTP surface (the
  `/c/<name>/file/...` and `/c/<name>/exec` routes the container
  example also exposes).
- No Dockerfile, no build script. The shell ships with
  `@cloudflare/computer/backends/worker-shell` as feature groups: an
  always-on core (`SHELL_CORE_MODULES`) plus one optional group per
  command at `@cloudflare/computer/shell/<feature>`. The backend
  assembles core with whatever groups you opt into and hands the
  result to the Loader callback itself.

The DO's backend wiring:

```ts
import curlModules from "@cloudflare/computer/shell/curl";
import sqliteModules from "@cloudflare/computer/shell/sqlite";

new WorkerShellBackend({
  loader: env.LOADER,
  workspace: { binding: "ContainerExample", id: ctx.id.toString() },
  ctx,
  commands: [curlModules, sqliteModules],
})
```

Run with `npm run dev --workspace @example/computer-worker`.
The same `curl` recipes from the container example work once
`curlModules` is passed to `commands`.

## Optional shell commands

Core carries the always-on command set (`cat`, `ls`, `grep`, `sed`,
`awk`, `sort`, …). The heavier commands are split into optional
groups that are opt-in by import: import a group from
`@cloudflare/computer/shell/<feature>` and pass it to the
`commands` option, and only then does its code enter your bundle.

```ts
import curlModules from "@cloudflare/computer/shell/curl";
import htmlToMarkdownModules from "@cloudflare/computer/shell/html-to-markdown";

// commands: [curlModules, htmlToMarkdownModules]
```

A group you never import is unreachable in your module graph, so
the bundler drops it — there is no build-time flag to set and no
default-on cost to opt out of. The full set of optional groups is
`curl`, `html-to-markdown`, `python`, `sqlite`, `js-exec`, `yq`,
`file`, `xan`, and `jq`.

`curl` runs on a `SecureFetch` adapter over the isolate's global
`fetch` — `undici` is redirected to a throwing stub at build time
and never ships. Egress stays governed by the Dynamic Worker's
`globalOutbound` (left `null`, i.e. closed), not by the shell, so
enabling `curl` does not by itself open the network.

Consumers that build the Loader callback by hand (the `fetcher`
path) assemble the modules table themselves with
`assembleShellModules([...groups])` from the same package.
