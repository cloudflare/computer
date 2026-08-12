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
`celld-javascript` Computer runtime backend. That backend supports simple
ECMAScript-module execution with JSON input/output. It does **not** yet expose
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
  -d '{"source":"console.log(\"running\"); export default (input) => ({ doubled: input.n * 2 })","input":{"n":21}}'
```

Expected shape:

```json
{
  "status": "completed",
  "exitCode": 0,
  "value": { "doubled": 42 }
}
```

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

## JavaScript environment gaps

The celld Worker Loader works for simple JavaScript execution, but these gaps
remain before Computer's full `WorkerJavaScriptBackend` can be used unchanged:

- **Cross-isolate `RpcTarget` bridge cloning**: passing Computer's
  `WorkspaceRuntimeBridge` into the loaded worker failed with
  `() => {} could not be cloned`. The prototype avoids that by returning a
  plain JSON result instead of passing host capability stubs.
- **Filesystem bridge**: because the bridge cannot be passed yet, loaded code
  cannot import Computer's durable `node:fs/promises` shim. celld's native
  `node:fs` compatibility is intentionally partial and reads return `ENOENT`.
- **Stream transfer for live stdout/stderr**: Computer's backend streams framed
  output through a `ReadableStream` passed back to the host. This prototype
  buffers `stdout`/`stderr` and returns them when execution completes.
- **Dynamic imports**: celld v0.1.0 rejected `import("entry.js")` inside a
  loaded worker. The runner statically imports the generated entry module.
- **Loaded-worker shape**: celld expects a default Worker with a `fetch`
  function even when using a named RPC entrypoint, so the runner includes both.
- **Agent runtime**: the Agents SDK bundles/deploys, but the live Agent request
  hit the celld managed-DB lock noted above.

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
  src/index.ts                Worker + DO + HTTP filesystem + JS backend routes
  script/local-s3-shim.mjs    tiny filesystem-backed S3-compatible endpoint
  script/local-dev.mjs        start shim, deploy, and run celld locally
  wrangler.jsonc              celld-supported Wrangler config subset
```
