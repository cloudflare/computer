# worker-shell example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Cloudflare Worker + Durable Object that runs a Workspace whose
shell is a **Dynamic Worker** loaded through `env.LOADER`. The
shell is [`just-bash`](https://github.com/vercel-labs/just-bash);
the user-facing HTTP surface mirrors
[`examples/container`](../container) so the same `curl`
recipes work, just without the container.

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (ContainerExample) ──► Workspace ──► WorkerShellBackend
                                                    │
                                                    │  env.LOADER.get(...)
                                                    ▼
                                              Dynamic Worker
                                              (ShellWorker)
                                                    │
                                                    │  env.HOST.get(id)
                                                    │    .getWorkspace()
                                                    ▼
                                          back to ContainerExample DO
```

1. The DO constructs a `WorkerShellBackend` from
   `@cloudflare/computer/backends/worker-shell`, passing the Loader
   binding, a `{binding, id}` reference to itself, and `ctx`.
   The backend handles the rest internally: it builds the Loader
   callback (with the code-split shell modules + the seek-bzip
   stub), mints a `WorkspaceServiceProxy` loopback through
   `ctx.exports.WorkspaceServiceProxy(...)`, calls
   `env.LOADER.get(...).getEntrypoint("ShellWorker")`, and turns
   the resulting Fetcher into a `ShellRPC`.
2. The loader callback wires the `WorkspaceServiceProxy` loopback
   into the Dynamic Worker's `env.HOST`. The proxy is a small
   WorkerEntrypoint whose `getWorkspace()` method does the
   namespace lookup on the host side and returns a
   `WorkspaceStub`. A raw `DurableObjectNamespace` doesn't
   survive structured clone into the loader's env; the
   binding-shape Fetcher the proxy produces does.
3. `ShellWorker` (shipped in
   `@cloudflare/computer/backends/worker-shell`) lives inside that
   Dynamic Worker. Each `exec(input)` calls
   `env.HOST.getWorkspace()`, builds a fresh `Bash` around a
   `WorkspaceFsAdapter` wrapping the stub's `.fs`, runs the
   command, and disposes the stub when the run settles.
4. Filesystem operations from inside `Bash` round-trip through
   the host DO's own RPC surface, so storage handles stay valid
   and one workspace per DO is the natural boundary.
5. `BackendHandle.sync` is `"none"`. There's a single
   authoritative store (the DO's SQLite); push and pull
   short-circuit. The runtime result's `pushed` / `pulled`
   counts are always zero.

The DO is a thin host. There's no Dockerfile; the Dynamic Worker
lifecycle is the loader's problem.

## Paths

`PUT /c/<name>/file/workspace/hello.txt` writes
`/workspace/hello.txt`, and
`GET /c/<name>/file/workspace/r2/x` reads `/workspace/r2/x` —
the URL and the on-disk path always match. Any URL outside
`/workspace` returns 400.

`exec` runs with `cwd` defaulting to `/workspace`. Commands run
inside the just-bash interpreter — broad textual tooling
(`cat`, `grep`, `awk`, `sed`, `jq`, `sort`, …) but not the full
Linux userland. The Dynamic Worker has `globalOutbound: null`,
so the shell can't reach the public internet on its own.

## R2 mount

Identical to the container example. Seed once with:

```sh
npm run seed:r2:local --workspace @example/computer-worker-shell

# or after deploy
npm run seed:r2 --workspace @example/computer-worker-shell
```

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command | argv, cwd?, encoding? }
                                       cwd defaults to /workspace
                                       → JSON { exitCode, stdout, stderr }
```

## Run it locally

No Docker, no extra build step. The shell ships as pre-bundled
feature groups inside `@cloudflare/computer/backends/worker-shell`: an
always-on core plus one optional group per command at
`@cloudflare/computer/shell/<feature>`. `WorkerShellBackend` assembles
core with whatever groups you pass to its `commands` option and
spreads the result into the Loader callback internally. This
example opts `curl` and `sqlite` in:

```ts
import curlModules from "@cloudflare/computer/shell/curl";
import sqliteModules from "@cloudflare/computer/shell/sqlite";

new WorkerShellBackend({
  loader: env.LOADER,
  workspace: { binding: "ContainerExample", id: ctx.id.toString() },
  ctx,
  commands: [curlModules, sqliteModules],
});
```

A group you never import (`html-to-markdown`, `python`, `js-exec`,
`yq`, `file`, `xan`, `jq`, or either of the two above) is
unreachable in the bundle and the bundler drops it — opting a
command in is a single import, and opting out is deleting it. The
core entry module parses on cold start; each opted-in group's
chunks stay cold until a script reaches for them.

```sh
npm run dev --workspace @example/computer-worker-shell
```

Smoke test (same recipes as the container example):

```sh
curl http://127.0.0.1:8787/

echo 'hello' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

curl http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"cat hello.txt && wc -l hello.txt","encoding":"utf8"}'
```

## Layout

```
examples/worker-shell/
  wrangler.jsonc    Worker + DO + worker_loaders binding
  src/index.ts      Worker handler + DO (ContainerExample)
```

Nothing else. The Dynamic Worker source ships from
`@cloudflare/computer/backends/worker-shell` as a pre-built module
string.

## Known limitations

- **Exec is run-and-collect.** The handler awaits
  `handle.result()` and emits one JSON response. just-bash
  itself doesn't stream chunks; the shell emits at most one
  stdout event and one stderr event per run.
- **`getExec` reattach is intentionally absent.** Each exec is
  scoped to its own call; an id observed in one envelope can't
  be reached from a later request.
- **PATH-walk diagnostics in `wrangler dev`.** just-bash probes
  every `$PATH` directory for every command name. Each miss
  prints an `Uncaught WorkspaceFsError: no such path: ...` in
  the dev log, even though just-bash catches the rejection
  locally. Cosmetic; exec returns the correct result.
