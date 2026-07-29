# `@cloudflare/think` triage example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

A small end-to-end example that uses [`@cloudflare/think`][think] and
[`agents/workflows`][workflows] to triage a GitHub issue. The agent
runs inside a [Cloudflare Container][containers] holding a
[`@cloudflare/workspace`][workspace] VFS; the workflow drives it
through one explore step (full toolset — the model decides whether
to attempt a fix or just gather findings), one tool-less structure
step that coerces the explore output into a zod schema, and a
terminal step that POSTs a unified diff back to the user.

[think]: https://www.npmjs.com/package/@cloudflare/think
[workflows]: https://developers.cloudflare.com/workflows/
[containers]: https://developers.cloudflare.com/durable-objects/containers/
[workspace]: ../../packages/workspace

## Shape

```
client (./triage)                worker                                   container
   │  POST /issue                   │                                         │
   ├──────────────────────────────▶ │  setContext + runWorkflow               │
   │                                ├──── TRIAGE_WORKFLOW ────────────────────▶   │
   │                                │     fetch-issue                          │
   │                                │     → set-phase:explore                  │
   │                                │     → explore  (tools, agentic loop) ──▶ wsd
   │  POST /webhook (progress)      │                                         │
   │  ◀───────────────────────────  │                                         │
   │                                │     → set-phase:structure                │
   │                                │     → structure  (step.prompt, no tools) │
   │                                │     → build-patch  (git diff via vfs)    │
   │  POST /webhook (DONE + patch)  │     → notify-done                         │
   │  ◀───────────────────────────  │                                         │
```

The worker exposes one route, `POST /issue`, with body
`{ issue_url, webhook_url }`. It derives a stable DO name from the
issue, binds the webhook into the agent, and starts the workflow. The
CLI runs that webhook server on `0.0.0.0` so a containerised worker can
reach it back over the host network.

## Tools

The agent has two phases. The workflow flips between them via
`agent.setPhase("explore" | "structure")` inside a `step.do` before
each model step, so a replay after a crash still ends up in the
right phase. `explore` has the full toolset; `structure` has none —
the model can't be tempted to keep calling tools when its job is to
just emit JSON.

| Tool            | Source                                           |
| --------------- | ------------------------------------------------ |
| `read`          | `@cloudflare/workspace/tools`                    |
| `ls`            | `@cloudflare/workspace/tools`                    |
| `write`         | `@cloudflare/workspace/tools`                    |
| `edit`          | `@cloudflare/workspace/tools`                    |
| `exec`          | `@cloudflare/workspace/tools` (optional shell)   |
| `share`         | `@cloudflare/workspace/tools` (optional assets)  |
| `report_update` | `src/tools/report-update.ts` (example-specific)  |

The Workspace tools come from `createAITools()` in
`@cloudflare/workspace/tools`. In the explore phase this example
includes `read`, `write`, `edit`, and `ls`, opts into `exec` by
passing shell backend descriptions, and includes `share` only when the
Workspace assets publisher is configured.

The `share` tool uploads a workspace file to R2 and returns a
time-limited link, so the agent can hand the user an artifact it
produced. The worker backend shell also exposes
`assets publish <path> [<expiry>]`, which prints the same kind of
link to stdout from `exec`. Both are registered only when the R2
credentials below are set; without them the agent runs unchanged and
the share surfaces are omitted. See
[`docs/14_assets_interface.md`](../../docs/14_assets_interface.md).

`exec` is wired to a Workspace with two backends: a `"shell"`
backend (just-bash in a Dynamic Worker through `env.LOADER`) and
a `"container"` backend (Cloudflare Container running `wsd`). The
shell backend is the default; the tool description tells the model
which backend each kind of command belongs on, and the model is
expected to try the cheap shell first and route to the container
for anything the shell can't run (`npm install`, language-specific
tooling, ...). See
[`docs/05_shell_interface.md`](../../docs/05_shell_interface.md)
for the backend selection model and the cross-backend write
caveat.

Git lives on the shell backend. The worker backend's just-bash
shell registers a built-in `git` command (see
[`docs/13_git_interface.md`](../../docs/13_git_interface.md)) that
forwards every invocation across the loopback to the host's
`workspace.git.cli(...)`. That means `git clone`, `git status`,
`git diff`, and friends run from inside `exec({ command: "git ...",
backend: "shell" })` even though the shell isolate has
`globalOutbound: null` — the actual HTTP request happens on the
host durable object, not in the isolate. Only `https://` URLs are
supported; `ssh://` and `git://` are rejected up front. The clone
runs at `depth=1` by default; pass `--depth=<N>` for more history.

The workflow itself reaches for the typed git API directly when
it needs a diff for the terminal webhook payload — see
`TriageAgent.gitDiff` in `src/agent.ts`, which calls
`workspace.git.diff` rather than going through `exec`. That skips
a shell round trip and gives the workflow the diff text in-band.

## R2-mounted skill

The DO mounts an R2 bucket (`R2_SKILLS`) at `/workspace/.agents` via
`R2Bucket(env.R2_SKILLS, { prefix: ".agents/" })`. On the first call
into the workspace the indexer pages through the bucket and streams
every object into `vfs_nodes`; from then on the agent sees
`/workspace/.agents/skills/triage/SKILL.md` like any other file. The
mount is read-only — writes under `/workspace/.agents` reject with
`EROFS`.

The system prompt tells the model to read that file before it
starts, so the playbook (clone, decide bet, fix or write findings,
report progress, summary contract) is delivered in-band instead of
being baked into the prompt.

Seed the bucket once with the bundled fixture before running:

```sh
# Local miniflare bucket — use this with `wrangler dev`.
npm run seed:r2:local --workspace @cloudflare/example-think

# Real Cloudflare R2 bucket — use this after `wrangler deploy`.
npm run seed:r2 --workspace @cloudflare/example-think
```

The fixture lives at
`examples/think/seed/r2-skills/.agents/skills/triage/SKILL.md`; edit
it and re-run the seed script to update the bucket. The DO picks the
new bytes up on the next session (eager mount, indexed once per
workspace lifetime).

## Running it locally

Requires Docker. The Dockerfile pulls
`ghcr.io/cloudflare/workspace-wsd-linux-x64:<version>` from the
public GitHub Container Registry on first build; no local image
prep is needed.

```sh
# From the repo root:
npm install

# Two terminals — worker on one, CLI on the other.
cd examples/think
npm run dev                                            # terminal 1
./cli/triage.mjs https://github.com/owner/repo/issues/42   # terminal 2
```

The CLI prints progress lines as they arrive, then the final commit
subject/body and a colourised unified diff. It exits 0 when the
worker emits a message ending in `DONE`.

Useful flags:

- `--worker URL` — point the CLI at a different worker base URL (also
  `TRIAGE_WORKER`). Default `http://127.0.0.1:8787`.
- `--host HOST` — host name the worker should call back on (also
  `TRIAGE_HOST`). Defaults to the first non-loopback IPv4. Override
  this if you're running the worker inside a container or VM and the
  auto-pick is wrong for that network.

## Configuration

The worker is configured in [`wrangler.jsonc`](./wrangler.jsonc):

- `AI` — Workers AI binding (model: `@cf/moonshotai/kimi-k2.6`).
- `LOADER` — Worker Loader binding. The TriageAgent's Workspace
  uses it to mint the Dynamic Worker that hosts the `"shell"`
  backend.
- `TriageAgent` — container-enabled DO that owns one Workspace + one
  Think agent per issue. The Workspace carries two backends: the
  worker backend through `env.LOADER` and the container backend
  through `this.ctx.container`.
- `TRIAGE_WORKFLOW` — workflow binding pointing at `TriageWorkflow`.
- `ASSETS` — R2 bucket the `share` tool uploads to. Create it once
  before deploying:

  ```sh
  wrangler r2 bucket create think-example-assets
  ```

The `share` tool also needs R2 S3 credentials to presign URLs — the
bucket binding alone can't mint them. Create an R2 API token scoped
to the bucket and set the values as secrets:

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

`R2_ENDPOINT` can be set instead of `CLOUDFLARE_ACCOUNT_ID` when
using a custom S3-compatible endpoint.

Without these the worker still runs; the `share` tool is not offered
to the model, and `assets publish` is not configured in the shell.

- `ARTIFACTS` — optional Cloudflare Artifacts binding, commented out
  by default. Uncomment the `artifacts` stanza in `wrangler.jsonc`
  and re-run `wrangler types` to enable it. `TriageAgent` then
  builds a session-scoped artifacts client so every repository it
  creates is isolated under the agent's own durable object id. The
  worker backend exposes the same client as an in-shell `artifacts`
  command, and the workflow's final step imports the source
  repository into Artifacts, pushes the agent's changes to a review
  branch, and includes the Artifacts remote and branch in the terminal
  webhook message. When the binding is absent, the demo runs unchanged
  and skips that publication step. See
  [`docs/15_artifacts_interface.md`](../../docs/15_artifacts_interface.md).

No GitHub auth. The issue must be on a public repository.

## Deploying

`wrangler deploy` works against any account that has Workers AI,
Workflows, and Cloudflare Containers enabled. After deploy, the CLI's
webhook URL must be reachable from your worker — use a tunnel
(`cloudflared tunnel`, `ngrok http`, etc.) and pass `--host` so the
CLI advertises the tunnel hostname instead of its local IP.

## What this example deliberately doesn't do

- Private repos / GitHub auth.
- Write back to the issue (comments, labels). The patch is returned to
  the CLI; applying it is the user's problem.
- Persistence of agent state beyond what Think and Workflows give us
  for free.
- Streaming exec output to a UI; the agent runs each `exec` to
  completion in one tool round.

