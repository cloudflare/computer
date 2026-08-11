# egress example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

This Worker sends one URL through all three Cloudflare Computer execution backends:

- the container shell runs `curl`;
- the Worker shell runs its `curl` command;
- Worker JavaScript runs `fetch`.

`EGRESS_MODE` applies the same egress policy to every backend.

| `EGRESS_MODE` | Workspace policy | Behavior |
| --- | --- | --- |
| `none` | `{ mode: "none" }` | Blocks outbound network access. This is the default. |
| `all` | `{ mode: "direct" }` | Allows direct outbound access. |
| `custom` | `{ mode: "http-gateway" }` | Routes requests through a gateway that allows only `https://example.com`. Other origins receive `403`. |

## Run it

The container backend requires Docker. Start the example with one of the three modes:

```sh
npm run dev --workspace @example/computer-egress -- --var EGRESS_MODE:none
npm run dev --workspace @example/computer-egress -- --var EGRESS_MODE:all
npm run dev --workspace @example/computer-egress -- --var EGRESS_MODE:custom
```

Then send a request:

```sh
curl -X POST 'http://127.0.0.1:8787/fetch?url=https%3A%2F%2Fexample.com'
```

The endpoint returns the status code and MIME type from each backend, or an error when no response was available:

```json
{
  "mode": "all",
  "url": "https://example.com/",
  "container": { "status": 200, "mimeType": "text/html" },
  "worker-shell": { "status": 200, "mimeType": "text/html" },
  "worker-javascript": { "status": 200, "mimeType": "text/html" }
}
```

With `EGRESS_MODE=none`, each backend returns an `error` object. With `EGRESS_MODE=custom`, try an origin outside the allowlist to see the gateway response:

```sh
curl -X POST 'http://127.0.0.1:8787/fetch?url=https%3A%2F%2Fcloudflare.com'
```

Each backend reports status `403` and MIME type `text/plain`.

## HTTP surface

```text
POST /fetch?url=<HTTP-or-HTTPS-URL>
```

The endpoint accepts only `POST`. Missing, malformed, and non-HTTP URLs return `400`.

## Layout

```text
examples/egress/
  Dockerfile                computerd, FUSE libraries, and curl
  wrangler.jsonc            Worker Loader, container, durable object, and EGRESS_MODE
  src/egress.ts             egress policy and response helpers
  src/index.ts              gateway, three backends, and HTTP handler
```
