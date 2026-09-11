# codemode example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Worker + Durable Object that boots a container in which any command
can run `codemode < script.js`. The script does not run in the
container: it travels back to the Durable Object and runs there, in a
dynamic worker, with the connectors the Durable Object configured in
scope as typed globals. Here that is one small `notes` connector over
the Durable Object's storage.

```
client ─► Worker POST /c/<name>/exec ─► DO ─► container: codemode < script.js
                                                              │
                                              ws://computer.internal/codemode
                                                              ▼
                                            DO: codemode runtime ─► dynamic worker
                                                    notes.add(), notes.list()
```

## What is where

`src/index.ts` is the Durable Object and a one-route Worker. The only
codemode-specific lines are the `codemode` option on
`CloudflareContainerBackend`, which names the loader, the Durable
Object state, and the connectors, and the two exports the runtime
needs: `WorkspaceProxy`, which carries the container's requests to the
Durable Object, and `CodemodeRuntime`, the facet the runtime keeps its
executions in. `wrangler.jsonc` lists `CodemodeRuntime` as a Durable
Object binding for the same reason.

`src/notes-connector.ts` is the whole connector. Swap it for connectors
over whatever the container should reach: KV, R2, an MCP server through
`McpConnector`, an OpenAPI service through `OpenApiConnector`.

`Dockerfile` copies both `computerd` and `codemode` out of the public
image.

## Run it

```sh
npm run dev --workspace @example/computer-codemode
./script/run
```

The script runs four commands inside the container through
`POST /c/demo/exec`:

```sh
codemode types                           # declarations of every global
codemode search "append a note"          # find a method
codemode describe notes.add              # declarations for one method
echo 'await notes.add({ text: "hello" }); return await notes.list({})' | codemode
```

A script is the body of an async function; `return` sends a value
back and `console.log` lines come back on stderr. Exit code 1 means
the script threw, 2 means `codemode` could not connect or was used
wrongly, and 3 means the run paused for approval on the host. There
is no command to approve it from the container, on purpose: a run
pauses because a connector asked for a human's decision.

## Tests

```sh
npm test --workspace @example/computer-codemode
```

The workers test opens `/codemode` on the Durable Object the way the
container would and runs scripts through the real runtime and dynamic
worker, without a container.
