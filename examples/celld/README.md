# celld example

> [!IMPORTANT]
> Prototype only. This is a small integration sketch for running a
> `@cloudflare/computer` Workspace inside a Worker deployed to
> [`denoland/celld`](https://github.com/denoland/celld).

This example uses celld as the Durable Object runtime and
`@cloudflare/computer` as the durable Workspace/filesystem layer. It includes a
small local S3-compatible shim so the prototype can run without AWS S3 or
Cloudflare R2.

It also wires celld's experimental Worker Loader into a small
`celld-javascript` Computer runtime backend in
`src/celld-javascript-backend.ts`. That backend supports ECMAScript-module
execution with JSON input/output, captured console output, and a second `ctx`
argument containing `env`, `cwd`, and `stdin`. It does **not** yet expose
Computer's full `WorkerJavaScriptBackend` filesystem/capability bridge; see
[JavaScript environment gaps](#javascript-environment-gaps).

## Architecture

```
client ─► celld HTTP (:8080)
             │
             ▼
       Worker fetch handler
             │ direct DO RPC methods
             ▼
       CelldWorkspace Durable Object
             │
             ├─ @cloudflare/computer Workspace filesystem (DO SQLite)
             │
             └─ celld-javascript backend
                    │ env.LOADER.load(...)
                    ▼
                  celld Dynamic Worker

celld deployment/state/leases ─► local S3 shim (:9000) ─► .celld-s3/
```

The Worker calls explicit methods on the Durable Object (`writeFile`,
`readFile`, `readdir`, `mkdir`, `rm`, `exec`) rather than using Computer's
nested `WorkspaceStub` from outside the object. That keeps the public surface
within celld's currently supported JS RPC shape.

## Run locally

Prerequisites:

- Node.js
- `celld` on your `PATH` (`curl -fsSL https://celld.dev/install.sh | sh`)
- dependencies installed from the repository root (`npm install`)

One-command local run:

```sh
npm run dev:local --workspace @example/computer-celld
```

That command starts `script/local-s3-shim.mjs`, runs `celld deploy`, then
starts `celld` on `127.0.0.1:8080` with `CELLD_WORKER_LOADER=LOADER`.

If you prefer separate terminals:

```sh
# terminal 1
npm run shim --workspace @example/computer-celld

# terminal 2
npm run deploy:local --workspace @example/computer-celld
npm run celld:local --workspace @example/computer-celld
```

## HTTP filesystem surface

All paths are absolute Workspace paths with the leading slash represented in
the URL. The handler rejects anything outside `/workspace`. A `cell` query
parameter selects the Durable Object name; it defaults to `default`.

```sh
# Help
curl http://127.0.0.1:8080/

# Write a file
echo 'hello from celld + computer' | curl -X PUT --data-binary @- \
  'http://127.0.0.1:8080/fs/workspace/hello.txt?cell=demo'

# Read the file back
curl 'http://127.0.0.1:8080/fs/workspace/hello.txt?cell=demo'

# List a directory
curl 'http://127.0.0.1:8080/ls/workspace?cell=demo'

# Create a directory
curl -X POST 'http://127.0.0.1:8080/mkdir/workspace/tmp?cell=demo'

# Delete a file
curl -X DELETE 'http://127.0.0.1:8080/fs/workspace/hello.txt?cell=demo'
```

Routes:

```
PUT    /fs/workspace/<path>          raw request body -> /workspace/<path>
GET    /fs/workspace/<path>          read /workspace/<path>
DELETE /fs/workspace/<path>          delete a file; add ?recursive=1 for dirs
GET    /ls/workspace/<dir>           JSON directory listing
POST   /mkdir/workspace/<dir>        mkdir -p
POST   /exec                         JavaScript module execution via celld Worker Loader
```

## JavaScript backend

Start celld with `CELLD_WORKER_LOADER=LOADER` and call `/exec`:

```sh
curl -X POST 'http://127.0.0.1:8080/exec?cell=demo' \
  -H 'content-type: application/json' \
  -d '{"source":"console.log(\"running\"); export default (input, ctx) => ({ doubled: input.n * 2, cwd: ctx.cwd, name: ctx.env.NAME })","input":{"n":21},"env":{"NAME":"celld"}}'
```

Expected shape:

```json
{
  "status": "completed",
  "exitCode": 0,
  "value": { "doubled": 42 }
}
```

User modules can either default-export a value or a function. If the default
export is a function, it is called as `default(input, ctx)`. The current `ctx`
shape is:

```ts
interface CelldExecContext {
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  fs: {
    readFile(): never;
    writeFile(): never;
    readdir(): never;
    mkdir(): never;
    rm(): never;
    stat(): never;
    exists(): never;
    ls(): never;
    find(): never;
    grep(): never;
  };
}
```

`ctx.fs` is present but intentionally throws a descriptive error today. I tried
passing a host filesystem `RpcTarget` into the loaded worker as a second step;
celld v0.1.0 rejected that capability argument with the same structured-clone
failure as the full Computer bridge. The outer HTTP `/fs` routes are the working
filesystem API for now.

The backend intentionally uses static imports in the generated runner because
celld v0.1.0 does not support dynamic `import("entry.js")` in loaded workers.
Loaded workers also need a default `fetch` export, so the runner includes a tiny
`fetch() { return new Response("ok") }` handler and exposes the evaluator as a
named `WorkerEntrypoint`.

## Agents SDK attempt

`FilesystemAgent` is included as a smoke-test attempt for the Cloudflare Agents
SDK on celld. It constructs a filesystem-only Computer Workspace and calls
`createAITools({ workspace, assets: false })`.

Routes:

```sh
curl 'http://127.0.0.1:8080/agents/filesystem-agent/demo'
curl 'http://127.0.0.1:8080/agents/filesystem-agent/demo/tools'
```

Status: the Worker bundles and deploys with celld once the `path` npm polyfill
is present, but a live request currently failed during celld restore with a
managed SQLite lock:

```text
celld restore failed for FilesystemAgent:...: open managed db .../db.sqlite: database is locked
```

So the Agents SDK wiring is present for iteration, but not counted as validated
working yet.

## Known gaps and follow-ups

The celld Worker Loader works for simple JavaScript execution, but there are a
few concrete gaps before this example can use Computer's full
`WorkerJavaScriptBackend` unchanged.

### 1. Host capability stubs cannot cross into the loaded worker yet

Computer's full backend passes a `WorkspaceRuntimeBridge` capability object into
the Dynamic Worker so user code can call back into the host Durable Object for
filesystem, module resolution, stdout/stderr events, and other runtime services.
Under celld v0.1.0, that argument failed during the loaded-worker RPC call:

```text
DataCloneError: () => {} could not be cloned
```

I also tried a smaller filesystem-only `RpcTarget` intended to back `ctx.fs`;
it failed with the same clone error. For now, `CelldJavaScriptBackend` only
passes plain structured-clone data (`input`, `env`, `cwd`, `stdin`) and returns
a plain JSON result plus buffered output.

Follow-up: celld's Worker Loader RPC needs to support passing capability stubs
(or a documented equivalent) as named-Entrypoint arguments between the host
Worker and a loaded Worker.

### 2. No durable filesystem inside loaded JavaScript yet

Because the host bridge cannot be passed, loaded code cannot import Computer's
durable `node:fs/promises` shim. The `ctx.fs` object is present to reserve the
intended API shape, but every method currently throws a descriptive error.
celld's native `node:fs` compatibility is not a replacement: it is intentionally
partial and reads return `ENOENT`.

Working filesystem access today is the outer HTTP API:

```text
PUT    /fs/workspace/<path>
GET    /fs/workspace/<path>
DELETE /fs/workspace/<path>
GET    /ls/workspace/<dir>
POST   /mkdir/workspace/<dir>
```

Follow-up: once capability stubs can cross into loaded workers, wire `ctx.fs`
first. After that, evaluate whether Computer's existing durable
`node:fs/promises` module bridge can be reused unchanged.

### 3. Output is buffered, not streamed live

Computer's full backend streams runtime events as they happen. This example
captures `console.log/info` as stdout and `console.warn/error` as stderr inside
the loaded Worker, then returns those buffers when the function completes.

Follow-up: support returning/transferring a stream or event capability from the
loaded Worker so `/exec` can expose live stdout/stderr and long-running task
status.

### 4. Loaded-worker module loading differs from Workerd

Two celld Worker Loader differences are handled in the example runner:

- Dynamic `import("entry.js")` failed under celld v0.1.0, so the runner uses a
  static `import * as userModule from "entry.js"`.
- The loaded Worker needed a default `fetch` export even though execution uses a
  named `WorkerEntrypoint`, so the runner exports both `Runner` and a tiny
  default `fetch()` handler.

Follow-up: decide whether these are intended celld constraints or compatibility
bugs. If they are fixed, the generated runner can become closer to Computer's
normal Worker JavaScript backend.

### 5. Agents SDK is bundled but not validated at runtime

`FilesystemAgent` bundles and deploys with celld once the `path` npm polyfill is
present, but a live Agent request hit a celld managed-SQLite restore failure:

```text
celld restore failed for FilesystemAgent:...: open managed db .../db.sqlite: database is locked
```

Follow-up: investigate celld's managed SQLite locking/restore path with Agents
SDK Durable Objects. The basic Worker and `CelldWorkspace` Durable Object paths
are validated; the Agent Durable Object is not yet counted as working.

### Current validation matrix

| Feature | Status | Notes |
| --- | --- | --- |
| Local S3 shim | Working | Supports the S3 subset celld uses for local deploy/run. |
| HTTP filesystem API | Working | Validated against actual celld with the local S3 shim. |
| `/exec` simple JavaScript | Working | Uses celld Worker Loader + named `WorkerEntrypoint`. |
| `default(input, ctx)` | Working | `ctx.env`, `ctx.cwd`, and `ctx.stdin` are available. |
| `ctx.fs` in loaded JavaScript | Gap | Placeholder only; host capability passing fails to clone. |
| Computer `WorkerJavaScriptBackend` unchanged | Gap | Blocked on host bridge/capability passing. |
| Live stdout/stderr streaming | Gap | Output is buffered until completion. |
| Agents SDK route | Gap | Bundles/deploys, but live request hit SQLite lock. |

## Local S3 shim

`script/local-s3-shim.mjs` implements the small path-style S3 subset celld uses
for local development:

- `PUT`, `GET`, `HEAD`, `DELETE` object requests
- `GET ?list-type=2&prefix=...` listings
- `If-Match` / `If-None-Match: *` conditional writes
- `ETag` and `x-amz-meta-*` headers

It is intentionally a development shim, not a complete S3 server. The on-disk
layout is `.celld-s3/<bucket>/<key>`.

## Layout

```
examples/celld/
  src/index.ts                    Worker + DO + HTTP filesystem routes
  src/celld-javascript-backend.ts celld Worker Loader module backend
  script/local-s3-shim.mjs        tiny filesystem-backed S3-compatible endpoint
  script/local-dev.mjs            start shim, deploy, and run celld locally
  wrangler.jsonc                  celld-supported Wrangler config subset
```
