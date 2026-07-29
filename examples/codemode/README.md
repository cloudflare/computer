# codemode example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Cloudflare Worker + Durable Object that runs one Workspace with
**three backends** and an optional **agent** layer on top:

- **`shell`** — [`just-bash`](https://github.com/vercel-labs/just-bash)
  in a Dynamic Worker. Fast, no container, broad text tooling.
- **`codemode`** — LLM-authored **JavaScript** in a Dynamic Worker,
  reaching the files through a `state.*` namespace. This is the
  backend the example is built to show off.
- **`container`** — `wsd` in a Cloudflare Container, a full Linux
  userland. Boots on first use only.

The workspace itself knows nothing about models. Agency is a
separate, opt-in layer: a `POST /agent` route runs a
[Workers AI](https://developers.cloudflare.com/workers-ai/) model
loop that drives the backends through an `exec` tool, and picks the
backend per command.

The agent asks before it acts. Commands the approval policy holds
back — anything that writes, and everything on `container` — pause the
turn until a human answers, which is what the
[approval flow](#human-in-the-loop-approval) below is about.

## What makes codemode different

The `shell` and `container` backends take a **shell command line**.
The `codemode` backend takes a **JavaScript snippet**. It runs the
snippet in an isolated Dynamic Worker and reports the return value
plus `console.log` output as stdout; a thrown error becomes stderr
with a non-zero exit code. The snippet reaches the filesystem
through a `state.*` namespace:

```js
await state.mkdir("/workspace", { recursive: true });
await state.writeFile("/workspace/hello.txt", "hello world");
return await state.readFile("/workspace/hello.txt");
```

The `state.*` namespace mirrors the filesystem surface the `shell`
backend already reaches — there is no security reason to keep it
smaller, since the agent chooses the backend and all three act on
the same store. Available calls:

- Reads: `readFile(path)` (utf8), `readFileBytes(path)` (returns a
  `Uint8Array`), `stat(path)`, `lstat(path)`, `exists(path)`,
  `readlink(path)`, `readdir(path)`, `find(dir, glob?)`,
  `ls(prefix)`, `grep(pattern, path, { ignoreCase? })`.
- Mutations: `writeFile(path, data)` (string or `Uint8Array`),
  `mkdir(path, { recursive })`, `rm(path, { recursive, force })`,
  `chmod(path, mode)`, `symlink(target, path)`.

The only filesystem operation left out is the streaming `readFile`
variant — a `ReadableStream` can't cross the sandbox boundary, so
codemode reads text through `readFile` and raw bytes through
`readFileBytes`.

The store the snippet touches is the same store `shell` and
`container` act on — one filesystem, three backends.

## Architecture

```
client ─► Worker ─┬─ /file, /exec   deterministic, no model
                  ├─ /agent         model loop + exec tool
                  └─ /approvals     the human's side of the loop
                         │
          ┌──────────────┴───────────────┐
          ▼                              ▼  (stub RPC)
   AgentSession DO              CodemodeExample DO  (owns fs + 3 backends)
   paused turns,                       ├─ shell     ─► Dynamic Worker (just-bash)
   pending approvals                   ├─ codemode  ─► Dynamic Worker (JS sandbox, state.*)
   (no fs, no backends)                └─ container ─► Cloudflare Container (wsd)

           all file operations route back to the one DO's SQLite store
```

- The DO owns the filesystem: `Workspace` builds it over the DO's
  own `ctx.storage` (SQLite). That DO is the single source of truth.
- Backends are registered on the Workspace but **connect lazily** —
  a backend is dialed on its first `exec`, not at construction. The
  `container` backend's `connect()` is what boots the container, so
  registering it costs nothing until the first command routes to it.
- The `codemode` backend is co-located with the Workspace and needs
  no loopback proxy: the sandbox reaches the host through `state.*`
  RPC dispatchers, not a durable-object-namespace binding. The
  `shell` backend adds a `WorkspaceServiceProxy` loopback, and the
  `container` backend adds `withWorkspaceContainer` plus a
  `WorkspaceProxy` egress loopback.
- `AgentSession` is a second durable object holding approval state.
  It is addressed by the same `<name>`, so `/c/demo/...` reaches one
  workspace and one session — two objects, one name. It holds no
  workspace stub and registers no backends, so the component that
  records approval decisions cannot run a command.

## The optional agent layer

`POST /agent` runs the model loop **in the Worker**, reaching the
workspace through its stub. The loop builds an `exec` tool whose
`backend` parameter is an enum of `shell` / `codemode` / `container`;
the model reads each backend's description and picks one per call.

Keeping the loop in the Worker (rather than in the DO) is
deliberate: the workspace stays a plain workspace, and agency is
opt-in per request. The tradeoff is that a Worker-hosted loop is
bound by Worker CPU and wall-clock limits; a long-running agent
would promote the loop to its own durable object holding a workspace
stub, without changing the workspace itself.

The model is Workers AI Kimi (`@cf/moonshotai/kimi-k2.6`) via
`workers-ai-provider`, wired to the `AI` binding. The `/agent` route
needs an authenticated wrangler session (`npx wrangler login`);
`/file` and `/exec` are fully local.

## Human-in-the-loop approval

The agent does not get to write to the filesystem on its own say-so.
When the model asks for a command the policy holds back, the command
**does not run**: the turn stops, the pending command is put on a
queue, and the turn resumes only after a human answers.

```
POST /agent {prompt}
      │
      ▼
  the model asks to run a command
      │
      ├─ policy allows it ──► runs ──► turn continues ──► status: completed
      │
      └─ policy holds it ───► NOTHING RUNS
                              status: awaiting-approval + turnId + approvalId
                              │
                     GET /approvals            shows command, backend, reason
                     POST /approvals/<id>      {approved: true|false}
                              │
                              ├─ more still outstanding ──► 202, keep answering
                              └─ that was the last one ───► turn resumes here,
                                                            may pause again
```

### The policy

Approval is a table keyed by backend, because the three backends
differ in what they can reach:

| Backend | Rule | Why |
|---|---|---|
| `shell` | `read-only` | Sandboxed, sees only the workspace. Recognized reads run unattended. |
| `codemode` | `read-only` | Same, and it has no network at all. |
| `container` | `always` | Full Linux userland with public network. "Which command is it" is the wrong question. |

Under `read-only`, a command runs unattended only when it is
*recognizably* a read. Anything the matcher does not understand needs
a human — an unknown verb, a shell metacharacter, a `state.*` call
reached through a computed access. The gate fails **closed**, which is
the only direction worth failing in.

The matcher speaks two dialects, because the backends do. For `shell`
and `container` it rejects redirection and composition (`>`, `|`, `;`,
`&&`, `$(...)`) outright, then requires the leading verb to be a known
read (`cat`, `ls`, `grep`, `find`, `git log`, …), and then — for verbs
that write when handed the wrong flag — requires the flags to be known
reads too. `find /workspace -name '*.ts'` runs;
`find /workspace -delete` and `sort -o out in` ask. For `codemode` it
reads the JavaScript instead: every mention of `state` has to resolve
to a named member, and every member has to be a read (`readFile`,
`stat`, `readdir`, …). That is why `state["writeFile"](...)` is gated.

Both dialects allowlist rather than blocklist, which is the only
version that holds up. A blocklist of writing flags has to keep pace
with every flag that happens to write; an allowlist turns the ones
nobody thought of into questions.

Some commands are left out of the read set entirely because their
writes cannot be read off their arguments: `sed` writes through `-i`
and through a `w` command buried in its script, `uniq` and `tree` take
an output file as a positional argument, `awk` and `echo` write through
their own syntax, and `date -s` sets the clock. Listing them would buy
false confidence rather than fewer approvals.

The rules are configuration, not a hardcoded list. `runAgentTurn`
takes a `policy`, and `never` turns the gate off for a backend
entirely:

```ts
const transcript = await runAgentTurn({
  env,
  workspace,
  prompt,
  policy: {
    rules: { shell: "read-only", codemode: "never", container: "always" },
    fallback: "always",
  },
});
```

Be clear-eyed about what this is: pattern-matching a command line is a
heuristic, appropriate for an example. A production gate belongs at
the capability layer — hand the backend a read-only view of the
workspace and let the filesystem refuse the write — rather than in a
matcher that has to anticipate every way a shell can be told to write
a file. Denying by default is what makes the heuristic's failure mode
tolerable in the meantime.

### Where a paused turn lives

`runAgentTurn` is a single `generateText` call inside a fetch handler.
It has nowhere to keep a half-finished turn, so the state that has to
survive the wait — the message history, the pending approvals, the
decisions already taken — lives in `AgentSession`, a second durable
object.

It is deliberately not in the workspace durable object. That object is
a filesystem with backends attached, and giving it a queue of
half-finished model turns would make it something else. The
[approval flow](#human-in-the-loop-approval) is the agent layer's
concern, so it gets its own durable object and the workspace stays a
workspace.

Resuming works by replay. A paused turn stores the AI SDK's own
message history, including the `tool-approval-request` part that
records what was asked. Approving appends a `tool-approval-response`
message and hands the whole history back to `generateText`, which
executes the approved call and carries on. A rejection becomes an
`execution-denied` result the model reads and reacts to, rather than
an error that ends the turn.

Two consequences worth knowing:

- **The policy has to be deterministic.** The AI SDK re-runs it when a
  turn resumes and downgrades an approved call to a denial if the
  answer changed in the meantime. So it is a pure function of the
  command and the backend — no clock, no mutable config — and a deploy
  that *relaxes* the policy will deny approvals that were in flight.
- **The step budget spans the whole turn.** `MAX_STEPS` is spent across
  every pass, not per pass, so waiting for a human does not buy the
  model a fresh allowance.

### Why not codemode's built-in approvals

`@cloudflare/codemode` ships its own approvals system —
`requiresApproval` on connector tools, `createCodemodeRuntime`, and
abort-and-replay through a durable tool-call log. This example does
not use it, and the naming makes that worth spelling out: the codemode
**backend** here (LLM-authored JavaScript in a Dynamic Worker) is not
the codemode **runtime**. They are different things that share a name.

The runtime's approvals belong to connectors and a `codemode({ code })`
tool. Adopting them would mean replacing the `exec` tool with a
connector-based path, wrapping all three backends as a connector, and
taking on replay's determinism rules — which would delete the thing
this example exists to show, that the model picks one of three
backends per command. The AI SDK's `needsApproval` gives the same
pause in one field on the tool that is already there. If you are
building on codemode connectors rather than workspace backends, the
runtime's approvals are the better fit; here they are not.

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command, cwd?, backend? }
                                       backend: shell | codemode | container
                                       (omit to use the default, shell)
                                       → JSON { exitCode, stdout, stderr }
POST /c/<name>/agent                   { prompt }
                                       → JSON transcript (see below)
GET  /c/<name>/agent/<turnId>          one turn's record: what it ran, what
                                       it waits for, decisions already taken
GET  /c/<name>/approvals               → JSON { pending: [...] } — commands
                                       waiting on a human
POST /c/<name>/approvals/<approvalId>  { approved, reason? }
                                       → 200 transcript of the resumed turn
                                       → 202 if approvals are still outstanding
                                       → 404 if that id is not waiting (unknown,
                                         or somebody already answered it)
```

A transcript is:

```jsonc
{
  "status": "completed",          // or "awaiting-approval"
  "turnId": "0af13a39-…",
  "text": "Created /workspace/greeting.txt…",
  "finishReason": "stop",
  "steps": 1,                     // this pass
  "stepsUsed": 2,                 // the whole turn
  "toolCalls": [ /* every command the turn ran, across passes */ ],
  "pendingApprovals": [
    { "approvalId": "…", "backend": "codemode", "command": "…", "reason": "…" }
  ]
}
```

`<name>` selects a workspace instance (durable object). Reuse a name
to share files across calls; use a new name for a clean slate. The
same name also selects the `AgentSession` that holds that workspace's
approval queue.

## Run it locally

```sh
npm run dev --workspace @example/workspace-codemode
```

The first launch builds the container image (~1–2 min). If your
network intercepts TLS (a corporate proxy with its own certificate
authority), see [Container notes](#container-notes) — you can also
skip the container entirely:

```sh
# shell + codemode only, no Docker
npx wrangler dev --enable-containers=false
```

### Smoke test

The quickest check is the bundled script, which drives the file
surface and all three backends against a running `wrangler dev` and
fails loudly if the one shared filesystem is not consistent across
them:

```sh
./script/run                       # against http://127.0.0.1:8787
CONTAINERS=1 ./script/run          # also read from the container
AGENT=1 ./script/run               # also run one agent turn
APPROVALS=1 ./script/run           # also drive the approval flow end to end
```

To do the same steps by hand:

```sh
B=http://127.0.0.1:8787/c/demo

# codemode: command is JavaScript using state.*
# (the /workspace root is materialized on first use, so no mkdir)
curl -X POST $B/exec -H 'content-type: application/json' -d '{
  "command":"await state.writeFile(\"/workspace/hello.txt\",\"hello world\"); return await state.readFile(\"/workspace/hello.txt\");",
  "backend":"codemode"
}'

# shell: reads the SAME file codemode wrote (proves one shared fs)
curl -X POST $B/exec -H 'content-type: application/json' \
  -d '{"command":"cat /workspace/hello.txt","backend":"shell"}'

# container: real Linux userland (boots on first use)
curl -X POST $B/exec -H 'content-type: application/json' \
  -d '{"command":"uname -a; node --version","backend":"container"}'

# agent: the model picks the backend (needs `npx wrangler login`)
curl -X POST $B/agent -H 'content-type: application/json' -d '{
  "prompt":"Read /workspace/hello.txt and tell me its exact contents."
}'
```

The `/agent` response includes `toolCalls[].backend`, showing which
backend the model chose for each command.

### Watching it ask

The quickest way to see an approval happen is the interactive driver.
It starts a turn and prompts on the terminal for every command the
policy holds back, which is what a real approval UI would do with the
same two routes:

```sh
./script/agent "Create /workspace/greeting.txt containing exactly: hello world"
```

```
APPROVAL NEEDED (codemode)
  await state.writeFile("/workspace/greeting.txt", "hello world");
  why: state.writeFile is not a recognized read-only call
  approve? [y/N] y
  approved
  ran [codemode] await state.writeFile("/workspace/greeting.txt", "hello world");

status  completed
steps   2
agent   Created /workspace/greeting.txt containing exactly `hello world`.
```

Answer `n` and the command never runs; the model is told it was denied
and reports back. It defaults to a fresh workspace each run, so the
first write always has to be approved. `AUTO_APPROVE=1` says yes to
everything, and piping answers (`printf 'y\nn\n' | ./script/agent …`)
scripts them.

### The approval flow by hand

The same thing with two curls, which is what the driver is doing. Use a
fresh workspace name so the "nothing ran yet" step proves something:

```sh
B=http://127.0.0.1:8787/c/hitl-demo

# 1. A read needs no approval: status "completed".
curl -sX POST $B/agent -H 'content-type: application/json' \
  -d '{"prompt":"Read /workspace/hello.txt and tell me its contents."}'

# 2. A write pauses: status "awaiting-approval", with an approvalId.
curl -sX POST $B/agent -H 'content-type: application/json' \
  -d '{"prompt":"Create /workspace/greeting.txt containing exactly: hello world"}'

# 3. The queue: command, backend, and why it was held.
curl -s $B/approvals

# 4. Nothing ran. This 404 is the point of the whole feature.
curl -s -o /dev/null -w '%{http_code}\n' $B/file/workspace/greeting.txt

# 5. Approve. The turn resumes in this request and returns its
#    transcript, which may pause again on the next command.
curl -sX POST $B/approvals/<approvalId> \
  -H 'content-type: application/json' -d '{"approved":true}'

# 6. Now the file is there.
curl -s $B/file/workspace/greeting.txt

# 7. Answering twice is refused, so a racy approval UI cannot run the
#    command twice: 404.
curl -sX POST $B/approvals/<approvalId> \
  -H 'content-type: application/json' -d '{"approved":true}'
```

To watch a rejection instead, ask for something destructive and deny
it. The model is told the command was denied and why, and reports back
rather than rerouting to another backend:

```sh
curl -sX POST $B/agent -H 'content-type: application/json' \
  -d '{"prompt":"Use the shell backend to delete everything under /workspace."}'
curl -sX POST $B/approvals/<approvalId> -H 'content-type: application/json' \
  -d '{"approved":false,"reason":"not authorised to delete the workspace"}'
```

The turn record keeps the audit trail:

```sh
curl -s $B/agent/<turnId>
```

## Container notes

The image pulls `wsd` from a public GHCR image and installs a Linux
userland from Debian.

- **Node comes from Debian, not NodeSource.** The
  [`examples/container`](../container) image installs NodeSource's
  Node 22 over HTTPS, which fails behind a network that intercepts
  TLS with its own certificate authority (the `curl` in the Docker
  build aborts with a self-signed-certificate error, and the whole
  `wrangler dev` refuses to start). This image installs Debian's
  `nodejs`/`npm` over the plain-HTTP mirror instead, so it builds in
  those environments too. The tradeoff is an older Node.
- **Lazy boot.** The container starts on the first `exec` routed to
  the `container` backend, and the handle is cached after that, so
  only that first call pays any boot cost.
- **Apple Silicon.** The `wsd` base image is amd64-only, so on Apple
  Silicon the container runs under emulation and you'll see a
  harmless `InvalidBaseImagePlatform` warning.

## Tests

The example's own tests cover the approval machinery, and need neither
a model nor a container:

```sh
npm test --workspace @example/workspace-codemode
```

Three suites. `approval-policy.test.ts` pins the policy: which commands
are recognized reads, that redirection and composition are gated, that
`state["writeFile"]` does not slip past the allowlist, and that the
decision is a pure function of its inputs. `turn-store.test.ts` drives
the paused-turn bookkeeping against an in-memory map — a turn waits for
its last approval, answering twice is a no-op, and stale turns are
pruned. `agent.test.ts` runs the whole pause/resume loop against a
scripted model (`MockLanguageModelV3`), asserting against a fake
workspace that a gated command **never reaches `shell.exec`**, that the
message history survives a JSON round trip, and that approving runs the
held-back command while rejecting does not.

The backend beneath it has two further test tiers, both under
`packages/workspace`:

```sh
# node unit tests (pure logic: state provider + exec-event mapping)
npx vitest run src/backends/codemode --workspace @cloudflare/workspace

# workerd integration tests (real Worker Loader + real Workspace)
npm run test:codemode-backend --workspace @cloudflare/workspace
```

The unit tests cover the `state.*` provider (positional args,
null-not-undefined returns, `exists` semantics, error propagation)
and the `ExecuteResult` → stdout/stderr/exit mapping (logs, return
values, the zero/false edge cases, errors). The integration tests
run real JavaScript snippets through the sandbox against a live
Workspace: output and exit codes, every `state.*` call, cross-checks
against the host filesystem, per-exec isolation, the no-network
guarantee, and `get()` returning `ENOENT`.

## Layout

```
examples/codemode/
  wrangler.jsonc          Worker + 2 DOs + worker_loaders + containers + AI
  Dockerfile              wsd + Debian userland for the container backend
  script/run              smoke test: file surface, 3 backends, approvals
  script/agent            one agent turn, prompting y/n for each approval
  src/index.ts            Worker handler + DO (CodemodeExample, 3 backends)
  src/agent.ts            the optional Workers AI model loop
  src/tools/exec.ts       the exec tool advertised to the model
  src/approval-policy.ts  which commands need a human, and why
  src/session.ts          AgentSession DO: where a paused turn lives
  src/turn-store.ts       the paused-turn bookkeeping, storage-agnostic
```

## Known limitations

- **Exec is run-and-collect.** Each backend emits at most one stdout
  and one stderr event per run; the handler awaits `handle.result()`
  and returns one JSON response.
- **`getExec` reattach is intentionally absent for codemode.** Each
  snippet runs to completion in its own isolate; an id can't be
  reached from a later request, so `get()` rejects with `ENOENT`.
- **Shell PATH-walk diagnostics in `wrangler dev`.** A `shell`
  command whose name matches a real Unix binary (`cat`, `ls`, …)
  makes just-bash probe every `$PATH` directory, and each miss
  prints `Uncaught WorkspaceFsError: no such path: ...`. Cosmetic;
  the command returns the correct result. The `codemode` backend
  doesn't do this (no `$PATH`), and `container` doesn't (real
  rootfs).
- **The file surface does not create parent directories.** A bare
  `Workspace` starts with an empty tree, and `PUT /file` maps to a
  single `writeFile`, so writing `a/b/c.txt` when `a/b` is absent
  rejects with `ENOENT`. The other examples avoid this for the mount
  root because registering a mount recursively creates its root; this
  example has no mount, so the durable object materializes
  `/workspace` itself on first use (see `#ensureRoot`). Deeper
  directories still need an explicit `state.mkdir(...)` or
  `mkdir -p`.
- **The agent loop runs in the Worker.** Fine for short tasks; a
  long agent run would want its own durable object. Approval state
  already lives in one (`AgentSession`), so a paused turn survives
  between requests even though the loop that produced it does not.
- **Approving resumes inline.** `POST /approvals/<id>` runs the rest of
  the turn in that request, so answering an approval costs a model
  round trip and can return `awaiting-approval` again. It keeps the
  demo to one curl per step; a UI would more likely resume in the
  background and poll the turn record.
- **The approval matcher is a heuristic.** It classifies command
  strings, so it is conservative by construction and will ask about
  commands that are in fact harmless. Real enforcement belongs at the
  capability layer, as the [policy section](#the-policy) spells out.
- **Telling the model not to reroute is advice, not a guarantee.** The
  system prompt asks it not to retry a denied command on another
  backend, and models do not always listen. That costs nothing: every
  attempt is classified afresh, so a reroute either produces a command
  the policy allows or asks again. The gate does not depend on the
  model cooperating.
