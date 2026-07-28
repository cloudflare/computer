# 16. Codemode backend

> [!NOTE]
> This doc reflects shipped code in
> `packages/workspace/src/backends/codemode/`. The example deployment
> lives at `examples/codemode/`.

The codemode backend is the third `WorkspaceBackend` shape the
package ships. Like the worker backend it runs in a Dynamic Worker
minted through `env.LOADER`, but the command it runs is a JavaScript
snippet rather than a shell line. The snippet executes in a fresh,
network-isolated sandbox and reaches the host workspace through a
`state.*` namespace. There is no second store and no sync round
trip; the host Durable Object's SQLite is the only authoritative
state.

Import via the sub-path so the codemode payload tree-shakes out of
consumers that don't use it:

```ts
import { CodemodeBackend } from "@cloudflare/workspace/backends/codemode";
```

## When to reach for it

All three backends act on the same store, and the caller (or agent)
picks which one runs a given command. The choice is about the shape
of the task, not access:

- The **worker** backend takes a shell line and is the natural fit
  for text tooling and `git` expressed as a pipeline.
- The **codemode** backend takes JavaScript and is the natural fit
  for logic over the files — loops, conditionals, shaping data, and
  returning a structured value rather than parsing text out of
  stdout.
- The **container** backend takes a shell line against a real Linux
  userland; reach for it when the command needs real binaries, a
  language runtime, or the network.

Reach for the codemode backend when:

- The task reads more clearly as code than as a shell line, or wants
  to compute and return a value.
- You want the tightest sandbox for model-authored code: the isolate
  has no network at all, and nothing carries over between runs.

## The `state.*` surface

The snippet reaches the filesystem through an async `state.*`
namespace. It mirrors the surface the worker backend already exposes
to just-bash, because keeping it smaller would not contain anything —
the agent picks the backend and every backend acts on the same store.

- Reads: `readFile(path)` (utf8), `readFileBytes(path)` (returns a
  `Uint8Array`), `stat(path)`, `lstat(path)`, `exists(path)`,
  `readlink(path)`, `readdir(path)` (names), `find(dir, glob?)`,
  `ls(prefix)`, `grep(pattern, path, { ignoreCase? })`.
- Mutations: `writeFile(path, data)` (string or `Uint8Array`),
  `mkdir(path, { recursive? })`, `rm(path, { recursive?, force? })`,
  `chmod(path, mode)`, `symlink(target, path)`.

```js
await state.mkdir("/workspace", { recursive: true });
await state.writeFile("/workspace/hello.txt", "hello world");
return await state.readFile("/workspace/hello.txt"); // → stdout
```

Every call forwards straight to the live `WorkspaceFilesystem`, so
the storage shape, mount rules, and read-only enforcement are the
same as the other backends. The functions take positional arguments:
codemode serializes a call's argument list and spreads it back into
the host function, so `state.writeFile("/a", "hi")` arrives as
`writeFile("/a", "hi")`.

The only filesystem operation left out is the streaming `readFile`
variant. Its `ReadableStream` cannot cross the host-to-sandbox call
boundary, so `readFileBytes` drains it into bytes host-side instead.
Binary survives the trip in both directions because codemode's
transport codec tags `Uint8Array` / `ArrayBuffer` values as base64;
the same tagging lets `writeFile` accept a `Uint8Array` body.
Convenience operations the shell adapter composes on top of the
primitives — `appendFile`, `cp`, `mv`, `readdirWithFileTypes` — are
not separate calls, because a snippet composes them in a line or two
of JavaScript.

## Wire shape

```
agent code
  │  Workers RPC
  ▼
host DO ─── Workspace ─── CodemodeBackend
                              │
                              │  env.LOADER (DynamicWorkerExecutor)
                              ▼
                       sandbox isolate (one per exec)
                       runs the JavaScript snippet
                              │
                              │  state.* tool call over the executor's
                              │  own host↔sandbox channel
                              ▼
                       state provider closures (host side)
                              │  forward to Workspace.fs
                              ▼
                       host DO's SQLite
```

Unlike the worker backend, the codemode backend needs no
`WorkspaceServiceProxy` loopback binding. The `state.*` functions are
plain closures that capture the live `Workspace.fs`; the codemode
executor carries the tool calls between the sandbox and those
closures, and the closures run in the host Durable Object's own
request context where its storage handles are valid.

## Isolation and lifecycle

`globalOutbound` stays at its default of `null`, so a snippet cannot
`fetch()` or `connect()` anywhere. Its only door to the outside is
the `state.*` namespace. Each `exec` runs in a throwaway isolate, so
there are no shared globals between runs and nothing to reattach to:
`getExec` rejects with `ENOENT`, and `killExec` / `disposeExec` are
no-ops.

## Output and exit mapping

The snippet's return value and any `console.log` output become
stdout; the return value is rendered after the logged lines. A
thrown error becomes stderr with exit code 1. A snippet that returns
nothing produces empty stdout and exit 0. The value `0` and other
falsy returns are rendered rather than dropped.

## Push and pull

`BackendHandle.sync` is `"none"`. With a single authoritative store
there is nothing to ship or fetch; `Workspace.push` and
`Workspace.pull` short-circuit and the reconcile pass on connect is
skipped. The exec bracket still calls them so the surface stays
uniform — every `ExecResult.pushed`, `pulled`, and `skipped` is
empty.

## The `/workspace` mount root is not created for you

A fresh workspace has an empty tree, and the filesystem does not
create parent directories on write, so a snippet that writes under
`/workspace` before the directory exists fails with `ENOENT`. Create
it first with `await state.mkdir("/workspace", { recursive: true })`,
or write under a path whose parent already exists. Deployments that
mount something under `/workspace` get the root for free, because
registering a mount runs the same recursive `mkdir`.

## Example

`examples/codemode/` is a single wrangler project that runs one
Workspace with all three backends (`shell`, `codemode`, `container`)
and an optional agent layer that drives them through a model. It
exposes the same `/c/<name>/file/...` and `/c/<name>/exec` routes as
the container and worker examples, plus a `/c/<name>/agent` route.
`script/run` is a smoke test that round-trips one file through every
backend.

That agent layer asks a human before it runs anything that writes, and
before anything at all on the `container` backend. A held-back command
does not execute: the turn pauses and resumes through
`/c/<name>/approvals` once someone answers. The approval policy and the
paused-turn state both live in the example, not in this backend — the
backend runs a command and reports the result, as it did before. See
the example's README for the flow.

Run with `npm run dev --workspace @example/workspace-codemode`.
