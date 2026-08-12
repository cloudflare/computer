# celld chat agent example

> [!IMPORTANT]
> Prototype only. This example runs a `@cloudflare/computer` Workspace and an
> Agents SDK chat agent on [`denoland/celld`](https://github.com/denoland/celld).

The example has one durable object, `CelldAgent`. It owns the chat history and
Workspace in the same SQLite database. The Worker exposes the standard Agents
WebSocket route and no separate filesystem or execution HTTP API.

The terminal client uses the AI SDK TUI. Workspace operations are available to
the model through `createAITools()`.

## Architecture

```text
terminal (`npm run chat`)
        │ AgentClient WebSocket
        ▼
/agents/celld-agent/<name>
        │ routeAgentRequest
        ▼
CelldAgent (AIChatAgent + withWorkspace)
        ├─ chat history in SQLite
        ├─ @cloudflare/computer Workspace in the same SQLite database
        │    └─ read, ls, find, grep, write, edit, and delete tools
        ├─ celld-javascript runtime backend
        │    └─ exec tool when env.LOADER is available
        └─ Cloudflare Workers AI REST API
             └─ account ID and API token from celld Worker vars
```

`CelldAgent.onChatMessage()` calls `getWorkspace(this)`, passes that Workspace
to `createAITools()`, and gives the resulting tools to the AI SDK tool loop.
There is no hand-written Durable Object RPC interface.

## Install celld

Install the current celld release and make sure `~/.local/bin` is on `PATH`:

```sh
curl -fsSL https://celld.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
celld --version
```

`celld deploy` also needs `esbuild` on `PATH`. Installing this repository's npm
dependencies provides it under `node_modules/.bin`.

Build `@cloudflare/computer` before deploying the example because the workspace
package resolves through its `dist` directory:

```sh
npm install
npm run build --workspace @cloudflare/computer
export PATH="$PWD/node_modules/.bin:$PATH"
```

## Configure Cloudflare credentials

celld does not provide the managed Workers AI binding. The agent configures
`workers-ai-provider` with an account ID and API token, which calls the
Cloudflare Workers AI REST API directly.

Create an API token with Workers AI read access, then set both values in your
local environment:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CLOUDFLARE_API_TOKEN=<api-token>
```

`dev:local` forwards these values to celld as `CELLD_VAR_*` Worker variables.
If you run the `celld` command yourself, set the prefixed names directly:

```sh
export CELLD_VAR_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
export CELLD_VAR_CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN"
```

Keep the API token in your local environment. Do not add it to
`wrangler.jsonc` or another tracked file.

## Run locally

From the repository root, start celld in one terminal:

```sh
export PATH="$PWD/node_modules/.bin:$HOME/.local/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CLOUDFLARE_API_TOKEN=<api-token>
npm run dev:local --workspace @example/computer-celld
```

`dev:local` starts the local S3-compatible shim, deploys the Worker, enables the
celld Worker Loader as `env.LOADER`, and listens on
`http://127.0.0.1:8080`.

Open the terminal chat in another terminal:

```sh
npm run chat --workspace @example/computer-celld
```

Each `--name` selects a separate agent with its own chat history and Workspace:

```sh
npm run chat --workspace @example/computer-celld -- --name demo
```

Client options:

- `--worker URL` or `CELLD_WORKER` selects the celld HTTP endpoint.
- `--name NAME` or `CELLD_AGENT_NAME` selects the agent instance.
- `--title TITLE` changes the terminal title.

The same client is available as the `celld-chat` package binary.

For a noninteractive chat transport check, run:

```sh
npm run smoke --workspace @example/computer-celld
```

The smoke client sends one message over the Agents WebSocket protocol and
requires the reply to contain `celld smoke reply`. Set `CELLD_PROMPT` to change
the message or `CELLD_EXPECT` to use a different expected phrase.

## Workspace tools

The agent receives these tools from `@cloudflare/computer/tools`:

| Tool | Purpose |
| --- | --- |
| `read` | Read a Workspace file. |
| `ls` | List a directory. |
| `find` | Find paths. |
| `grep` | Search file contents. |
| `write` | Create or replace a file. |
| `edit` | Apply targeted replacements. |
| `delete` | Remove a file or directory. |
| `exec` | Run an ECMAScript module in a celld Dynamic Worker. |

`exec` is present only when celld injects `env.LOADER`. It uses the
`celld-javascript` backend in `src/celld-javascript-backend.ts`.

## JavaScript backend limits

The celld Worker Loader can run JavaScript modules with JSON input and output.
The source passed to `exec` must be a complete module, not a filename or a bare
script. It must have a default export. A default function receives `(input,
ctx)`, where `ctx` includes `env`, `cwd`, and `stdin`:

```js
export default async function main(input, ctx) {
  console.log("cwd:", ctx.cwd);
  return { received: input };
}
```

`ctx.cwd` is metadata; the directory is not mounted in the Dynamic Worker.

The backend does not yet provide the full Computer
`WorkerJavaScriptBackend` bridge:

- Capability stubs cannot cross into the loaded Worker, so `ctx.fs` methods
  throw and durable `node:fs/promises` is unavailable there.
- Output is buffered until execution finishes instead of streamed live.
- The generated runner uses a static import and a small default `fetch` export
  to match celld v0.1.0's Worker Loader behavior.

The host-side file tools remain fully functional because they operate directly
on the Workspace owned by `CelldAgent`.

## Local storage

`script/local-s3-shim.mjs` implements the small path-style S3 subset celld uses
for local deployment and state replication. It stores data under
`.celld-s3/`. The shim is for development only.

## Layout

```text
examples/celld/
  cli/chat.mjs                    AI SDK terminal client
  src/index.ts                    chat agent and Worker entrypoint
  src/celld-javascript-backend.ts celld Worker Loader runtime backend
  script/local-s3-shim.mjs        local S3-compatible endpoint
  script/local-dev.mjs            deploy and run celld locally
  script/smoke.mjs                noninteractive WebSocket chat check
  wrangler.jsonc                  celld-supported Worker configuration
```
