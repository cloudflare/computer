# celld example

> [!IMPORTANT]
> Prototype only. This is a small integration sketch for running a
> `@cloudflare/computer` Workspace inside a Worker deployed to
> [`denoland/celld`](https://github.com/denoland/celld).

This example uses celld as the Durable Object runtime and
`@cloudflare/computer` as the durable Workspace/filesystem layer. It includes a
small local S3-compatible shim so the prototype can run without AWS S3 or
Cloudflare R2.

There are intentionally **no Computer runtime backends** in this example. celld
has an experimental Dynamic Worker loader, but the current celld RPC/clone
surface is not enough for Computer's `WorkerJavaScriptBackend` bridge. This
prototype focuses on the filesystem API.

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
             ▼
       @cloudflare/computer Workspace filesystem (DO SQLite)

celld deployment/state/leases ─► local S3 shim (:9000) ─► .celld-s3/
```

The Worker calls explicit methods on the Durable Object (`writeFile`,
`readFile`, `readdir`, `mkdir`, `rm`) rather than using Computer's nested
`WorkspaceStub` from outside the object. That keeps the public surface within
celld's currently supported JS RPC shape.

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
starts `celld` on `127.0.0.1:8080`.

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
```

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
  src/index.ts                Worker + Durable Object + HTTP filesystem routes
  script/local-s3-shim.mjs    tiny filesystem-backed S3-compatible endpoint
  script/local-dev.mjs        start shim, deploy, and run celld locally
  wrangler.jsonc              celld-supported Wrangler config subset
```
