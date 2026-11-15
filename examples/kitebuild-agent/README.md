# Kitebuild agent example

> [!IMPORTANT]
> This example uses an experimental part of Cloudflare Computer: the Kitebuild backend.
> Its API may change in any release, and it is not yet suitable for
> production use. See the [status table](../../packages/computer/README.md#status).

One Workspace, one `KitebuildBackend`, and everything an agent needs to
work on JavaScript projects: a shell, a way to run Node.js scripts,
project files shipped with the Worker, and a
[pi](https://github.com/earendil-works/pi) agent on top. The shell is a
Kitebuild machine, a BusyBox Linux userland in the Workspace's own
Durable Object, with Kitebuild's toolchain, so `npm`, `node`, `tsc`,
`vite` and `vitest` run inside the Worker, with no container.

| Route | What it does |
|---|---|
| `PUT`/`GET /c/<name>/file/workspace/<path>` | write and read Workspace files |
| `POST /c/<name>/exec` | run a shell command: BusyBox with real processes, pipes and background jobs, plus `git`, `rg`, `jq`, `curl` and the toolchain |
| `POST /c/<name>/run` | run a Node.js script with `node` |
| `POST /c/<name>/agent` | give the agent a task; it can clone, install, typecheck, test, build, commit and push. With `"stream": true`, each step arrives as it happens |

The page at `/` puts the agent and a shell side by side.

The Worker is built with Vite, and `computerBundle()` ships `src/skills`
into every Workspace with `WorkerBundle`. Everything shares one store: a
file written through one route is there for the others, for every
command and script, and for the agent.

```
page or client ─► Worker /c/<name>/{file,exec,run,agent}
                     │  (Durable Object RPC calls)
                     ▼
               Agent ──► Workspace ──► KitebuildBackend
         (Durable Object)    │               │
                 │           │               ▼
                 │           │   ┌─ Kitebuild machine ──────────────────┐
                 │           │   │ processes:                           │
                 │           │   │   sh, sort, awk     (busybox.wasm)   │
                 │           │   │   rg, jq, rolldown  (wasm)           │
                 │           │   │   git, curl, npm    (JavaScript) ────┼──► Worker Loader
                 │           │   │   node, tsc, vite, vitest            │    isolates
                 │           │   │        │ Linux syscalls              │    (package code)
                 │           │   │        ▼                             │
                 │           │   │ kernel (TypeScript): processes,      │
                 │           │   │ pipes, descriptors, VFS              │
                 │           │   │        │                             │
                 │           │   │        │ /workspace mount            │
                 │           │   └────────┼────────────────────┬────────┘
                 │           ▼            ▼                    │ git, curl, npm
                 │      Durable Object SQLite storage          ▼
                 │      (one copy of every file)          EgressGateway ──► GitHub, npm
                 ▼
          Workers AI, through env.AI
```

## The backend

```ts
new KitebuildBackend({
  commands: [
    rg(),
    jq(),
    toolchain({
      loader: env.LOADER,
      exports: ctx.exports,
      groups: [
        essentialsTools,
        nodeTools,
        typescriptTools,
        viteTools,
        vitestTools,
        wranglerTools,
      ],
    }),
  ],
});
```

`commands` lists what the shell has beyond BusyBox and `git`. `rg()` and
`jq()` come from `@cloudflare/kitebuild-cli-tools`: the upstream tools,
compiled to wasm. `toolchain()`, from
`@cloudflare/kitebuild-toolchain/toolset`, turns the program groups you
pick into one entry and fills in what they need: the Worker Loader
binding, and the entrypoints the toolchain runs package code in, which
`src/index.ts` re-exports from `@cloudflare/kitebuild-toolchain/host-runtime`
so they appear on `ctx.exports`. Each group is imported from its own
subpath, so the Worker uploads only those groups' wasm:

| Group | Commands |
|---|---|
| `essentialsTools` | `curl`, `git` |
| `nodeTools` | `node`, `npm`, `npx`, `pnpm`, `bun`, `bunx` |
| `typescriptTools` | `tsc` |
| `viteTools` | `vite`, `tailwindcss` |
| `vitestTools` | `vitest` |
| `wranglerTools` | `wrangler` |

Commands come in two kinds. BusyBox, `rg`, `jq`, and the bundler,
parser and CSS tools the groups bring with them (`rolldown`, `oxc`,
`lightningcss`) are the upstream programs built for WebAssembly, and
behave as they do anywhere. The rest are Kitebuild's own
implementations of those commands, in JavaScript, covering what builds
and tests use. Their coverage grows with each Kitebuild release:

| Command | What to know |
|---|---|
| `node` | runs a script, `-e` or `-p` in an isolated Worker: no native addons, no child processes, and only a few environment variables; `require` and `import` both load Node's built-in modules, and one that workerd's `nodejs_compat` lacks fails with its name |
| `npm`, `npx`, `pnpm` | `npm` covers `install`, `ci`, `run`, `test` and `exec` |
| `bun`, `bunx` | Bun's package manager and script runner: `bun install` installs from `bun.lock`, and `bun run` runs scripts with their pre and post hooks; Bun's runtime, bundler and test runner are refused by name |
| `tsc` | the project's own TypeScript, for typechecking; it never writes output files |
| `vite`, `vitest` | Kitebuild's pinned releases, running the project's config and tests, with a warning when the project asks for another version; KV namespaces, R2 buckets and D1 databases a test config declares start empty for each run and spec file, kept in this Worker's `KvHost`, `R2Host` and `D1Host` Durable Objects, which `RemoteBindingOrigin` reaches through the `KB_REMOTE` service binding |
| `wrangler` | `deploy --dry-run` bundles the Worker and lists its bindings without uploading; a real deploy needs an API token and a route to the Cloudflare API, which the example's egress refuses, and `dev` is not implemented |
| `git` | built on isomorphic-git, with the common subcommands |
| `curl` | requests through the backend's egress |

When one of them meets something it doesn't support, it stops before
doing any work, with exit code 3 and a `kitebuild: unsupported:
<feature>: <reason>` line on stderr, rather than half-working. Set
`KITEBUILD_UNSUPPORTED=warn` in the command's environment to keep going
with a warning instead.

`tsc` only typechecks and never writes output files, so a project builds
with `vite build`. A skill at `/skills/exec/SKILL.md` tells the agent
what the shell can and can't do. It is mounted outside `/workspace`,
because a read-only mount inside it would stop pi's `write` tool from
writing files directly in `/workspace`.

## Running Node.js scripts

`POST /c/<name>/run` takes `source`, a Node.js script, and optionally
`args`, `stdin`, `env` and `cwd`. Kitebuild's `node` runs it in an
isolated Worker inside the machine, with top-level `await`, `node:`
modules, `process.argv` and `process.stdin`, and the reply is its
`stdout`, `stderr` and `exitCode`:

```sh
curl -X POST http://localhost:4173/c/demo/run \
  -H 'content-type: application/json' \
  -d '{"source":"import { readFile } from \"node:fs/promises\";\nconst text = await readFile(\"/workspace/hello.txt\", \"utf8\");\nconsole.log(JSON.stringify({ text: text.trim(), args: process.argv.slice(2) }));","args":["a","b"]}'
```

```json
{ "exitCode": 0, "stdout": "{\"text\":\"hello\",\"args\":[\"a\",\"b\"]}\r\n", "stderr": "" }
```

The script reads and writes the same files as the shell, and can import
or `require` the packages a project installed when `cwd` is that
project's directory. As in Node, the script follows that project's
`"type"`: in a `"type": "module"` project it is an ES module, so use
`import` there, since `require` throws. `node` runs only an entry inside
the project it starts in, so the route writes the script to `<cwd>/run-<id>.js` and
removes it after. Package code sees only a short list of environment
variables, such as `HOME`, `PATH`, `CI` and `NODE_ENV`, plus any that
start with `PUBLIC_` or `VITE_`, so secrets in the shell's environment
stay out of it.

## The page

`index.html` and `ui/` are a small page, built by the same Vite build
and served as static assets, with no framework beyond
[xterm.js](https://xtermjs.org) for the terminal. Type a task and the
log shows each step as the agent takes it: its notes, every tool call,
and each command's output, which opens on click. The terminal on the
right runs commands in the same Workspace, to check the agent's work
with `git log` or `npm test`: output streams as it is written, colors
show, `cd <dir>` on its own changes the directory later commands run
in, and Ctrl-C stops the running command. Each command runs to the end
in a fresh shell with no keyboard input, so programs such as `vi` don't
work there. The workspace name at the top picks which Workspace both
use.

The page reads `POST /c/<name>/agent` with `"stream": true`, which
sends newline-delimited JSON: `text` for the agent's notes, `call` and
`result` for each tool call, and `done` with the final reply, or
`error`.
The terminal reads `POST /c/<name>/exec` with `"stream": true`, which
sends `stdout`, `stderr` and `exit` events, and stops a command with
`POST /c/<name>/kill`, giving the `id` it started the command with.

The conversation is not kept: a reload starts a new one, while the
Workspace's files stay. Keeping it is a small addition, for example by
storing the messages in the Durable Object's storage after each turn and
loading them when a run starts.

## Network

Every request the shell makes, `npm install` and `git` included, goes
through `EgressGateway` in `src/index.ts`, which lets through GitHub and
the npm registry and refuses the rest. The log shows each decision:

```
egress allow GET registry.npmjs.org
egress deny GET example.com
```

To let the agent push to GitHub, give the Worker a token with write
access to the repository:

```sh
printf 'GITHUB_TOKEN=github_pat_...\n' > .dev.vars      # local
npx wrangler secret put GITHUB_TOKEN                    # deployed
```

The backend's git `fetch` adds it to git's requests for github.com on the
host side, so the token is never in the shell's environment, where the
agent or any package script could read it. Without it, clones and pulls
of public repositories still work.

> [!WARNING]
> The example's routes have no authentication. Anyone who can reach a
> deployed copy can run commands, and with `GITHUB_TOKEN` set, push to
> every repository the token can write to. Don't deploy it publicly with
> a token: keep it local, put it behind
> [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/),
> or use a fine-grained token limited to one repository.

## Packages

The `@cloudflare/kitebuild-*` packages are not on public npm yet. Until
they are, `npm install` fetches them from Cloudflare's internal npm
registry; see [`COLLABORATORS.md`](../../COLLABORATORS.md#setup) for the
token it needs.

## Run it locally

```sh
npm install
npm run dev --workspace @example/computer-kitebuild-agent
```

`preview` builds the Worker with Vite and serves the build at
`http://localhost:4173`; `dev` does the same, so a change needs a
restart. Vite's dev server does not work with this Worker yet: the
toolchain loads its wasm on first use, which needs the
`new_module_registry` compatibility flag, and under the dev server that
load fails, so `node`, `vitest` and anything else that bundles exits
with `rolldown exit 127`.

The `AI` binding always runs remotely. If your Wrangler login has access
to more than one account, set `CLOUDFLARE_ACCOUNT_ID` before starting.

Write a file, then reach it from the shell:

```sh
echo hello | curl -X PUT --data-binary @- http://localhost:4173/c/demo/file/workspace/hello.txt

curl -X POST http://localhost:4173/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"rg -c hello hello.txt && head -3 /skills/exec/SKILL.md"}'
```

Open `http://localhost:4173` and give the agent a task, or call the
route yourself:

```sh
curl -X POST http://localhost:4173/c/demo/agent \
  -H 'content-type: application/json' \
  -d '{"task":"Clone https://github.com/<you>/<repo> into /workspace/repo, install it, run its tests, fix any that fail, and commit the fix."}'
```

The reply is the agent's summary and the commands it ran; add
`"stream": true` to get each step as it happens. Ask it to push once
`GITHUB_TOKEN` is set.

The agent uses `@cf/moonshotai/kimi-k2.6`. pi sends tool results as
content arrays, and Llama 3.3, Qwen 3 and gpt-oss on Workers AI accept
only string content, so they fail on the second turn; pick a replacement
in `MODEL` in `src/index.ts` that takes OpenAI-format messages.

## Size

The built Worker is about 28 MB, 8.8 MB compressed: BusyBox, `rg`, `jq`,
and the toolchain's JavaScript and wasm, chiefly Rolldown. That needs the
Workers Paid plan, whose limit is 10 MB compressed. Leave out a group you
don't need to shrink it.

## Layout

```
examples/kitebuild-agent/
  index.html, ui/      the page: the agent's log and a terminal
  vite.config.ts       the Cloudflare Vite plugin and computerBundle()
  wrangler.jsonc       Worker + DOs, assets, AI, Worker Loader and KB_REMOTE bindings
  src/index.ts         Worker routes, the agent DO and the egress gateway
  src/workers-ai.ts    pi's Workers AI provider over the AI binding
  src/skills/          Files mounted read-only at /skills
```
