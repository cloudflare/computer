# container example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

A Cloudflare Worker + Durable Object that boots a Container running the
`computerd` daemon and exposes a minimal `write` / `read` / `exec` HTTP
surface.

## Container configuration

Declare the available images in `wrangler.jsonc`. Wrangler prepares each
image and exposes it through `ctx.container.images`:

```jsonc
"containers": [
  {
    "class_name": "ContainerExample",
    "scheduling_policy": "durable_object",
    "images": { "app": { "dockerfile": "./Dockerfile" } }
  }
]
```

Select the image when you create the backend:

```ts
new ContainerBackend({
  container: () => this,
  workspace: { binding: "ContainerExample", id: this.ctx.id.toString() },
  name: "app", // the images key above; "app" is the default
});
```

Set the instance size on the backend:

```ts
new ContainerBackend({
  // ...
  instance: "standard-2",
});
```

The `containers` entry accepts these fields:

| Field | Purpose |
| --- | --- |
| `name` | Names the container application. |
| `class_name` | Names the Durable Object class that owns the container. |
| `scheduling_policy` | Set to `"durable_object"` so each Durable Object manages its container. |
| `images` | Declares the named images available through `ctx.container.images`. |
| `observability` | Configures logging for the container application. |
| `unsafe` | Holds restricted experimental settings. |

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (ContainerExample) ──► Container ──► computerd (:8080)
             ▲                                  │
             │      ws://computer.internal/api │
             └────────── capnweb session ◄──────┘
```

1. The DO constructs a `ContainerBackend` and hands it to a `Workspace`.
   The backend owns the computerd lifecycle: it starts the container with
   the image and size above, wires egress, probes `/health`, and asks
   computerd to dial back.
2. computerd's outbound `/api` upgrade is intercepted by the egress and
   lands on the DO's `fetch`, which forwards it to `backend.handleFetch`.
3. The resulting capnweb session carries filesystem sync and `exec`.

If a container fails its startup health check, the replacement uses the
same image and instance size.

## Running it

```bash
npm run dev --workspace @example/computer-container
```

```bash
# write a file into the workspace
curl -X PUT --data 'hello' \
  http://localhost:8787/c/demo/file/workspace/hello.txt

# read it back
curl http://localhost:8787/c/demo/file/workspace/hello.txt

# run a command against it
curl -X POST -H 'content-type: application/json' \
  -d '{"command":"cat /workspace/hello.txt"}' \
  http://localhost:8787/c/demo/exec
```

Local development needs Docker. `wrangler dev` builds the image and runs it
against the local daemon.
