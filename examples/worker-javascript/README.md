# worker-javascript example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Cloudflare Worker + Durable Object that runs a Workspace whose
runtime evaluates **ECMAScript modules** in a **Dynamic Worker**
loaded through `env.LOADER`. It mirrors
[`examples/worker-shell`](../worker-shell) beat for beat — same DO
class, same routes, same R2 mount — but `exec` runs a JavaScript
module instead of a just-bash command.

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (ContainerExample) ──► Workspace ──► WorkerJavaScriptBackend
                                                    │
                                                    │  env.LOADER.load(...)
                                                    ▼
                                              Dynamic Worker
                                              (module runner)
                                                    │
                                                    │  evaluate(input, bridge)
                                                    ▼
                                          host capability bridge
                                          (fs, git, artifacts)
```

1. The DO constructs a `WorkerJavaScriptBackend` from
   `@cloudflare/computer/backends/worker-javascript`, passing only
   the Loader binding. Unlike the shell backend there is no
   `WorkspaceServiceProxy` loopback: the backend is self-contained
   and reaches the host through the `WorkspaceRuntimeBridge` it
   builds internally.
2. Each `exec(source, { backend: "worker-javascript", input })`
   builds a module graph from the source, mints a fresh Dynamic
   Worker through `env.LOADER.load(...)`, and calls the runner's
   `evaluate(input, bridge)`. The module's default export receives
   the structured `input` and its return value becomes the
   result's `value`.
3. Filesystem, Git, and artifacts operations from inside the module
   round-trip through the bridge to the host DO's own store, so
   storage handles stay valid and one workspace per DO is the
   natural boundary.
4. `BackendHandle.sync` is `"none"`. There's a single authoritative
   store (the DO's SQLite); push and pull short-circuit.
   `pushed` / `pulled` are always zero.

The backend requires `waitUntil`, so the DO passes
`ctx.waitUntil.bind(ctx)` into the Workspace options. The DO is a
thin host; the Dynamic Worker lifecycle is the loader's problem.

## Paths

`PUT /c/<name>/file/workspace/hello.txt` writes
`/workspace/hello.txt`, and
`GET /c/<name>/file/workspace/r2/x` reads `/workspace/r2/x` —
the URL and the on-disk path always match. Any URL outside
`/workspace` returns 400.

`exec` runs with `cwd` defaulting to `/workspace`. The source is
an ECMAScript module; its default export may be a function that
receives the request's `input` value and returns a
JSON-compatible result. The Dynamic Worker has
`globalOutbound: null`, so the module can't reach the public
internet on its own.

## R2 mount

Identical to the worker-shell example. Seed once with:

```sh
npm run seed:r2:local --workspace @example/computer-worker-javascript

# or after deploy
npm run seed:r2 --workspace @example/computer-worker-javascript
```

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { source, input?, cwd?, env?, stdin? }
                                       cwd defaults to /workspace
                                       → JSON { status, exitCode, stdout, stderr, value }
```

## Run it locally

No Docker, no extra build step. The module runner ships inside
`@cloudflare/computer/backends/worker-javascript`;
`WorkerJavaScriptBackend` mints the Dynamic Worker through the
Loader binding internally so the DO constructor stays a one-line
backend invocation.

```sh
npm run dev --workspace @example/computer-worker-javascript
```

Smoke test:

```sh
curl http://127.0.0.1:8787/

echo 'hello' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

curl http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"source":"import { readFile } from \"node:fs/promises\";\nexport default async () => (await readFile(\"/workspace/hello.txt\", \"utf8\")).trim();"}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"source":"export default (input) => input.n * 2;","input":{"n":21}}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"source":"export default async () => { let s = \"\"; for await (const c of process.stdin) s += new TextDecoder().decode(c); return process.env.WHO + \":\" + s; };","env":{"WHO":"demo"},"stdin":"piped"}'
```

`env` populates `process.env` (only the values you pass; the host
environment is never exposed), and `stdin` is readable through
`process.stdin`. `console.log` / `console.error` and
`process.stdout` / `process.stderr` writes come back as the result's
`stdout` and `stderr`.

## Layout

```
examples/worker-javascript/
  wrangler.jsonc    Worker + DO + worker_loaders binding
  src/index.ts      Worker handler + DO (ContainerExample)
```

Nothing else. The Dynamic Worker module runner ships from
`@cloudflare/computer/backends/worker-javascript`.

## Known limitations

- **Exec is run-and-collect.** The handler awaits
  `handle.result()` and emits one JSON response.
- **One execution at a time by default.** The backend admits a
  single execution per workspace unless configured otherwise, and
  bounds completed-execution retention by time and count.
