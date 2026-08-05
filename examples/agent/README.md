# agent example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

An agent that runs shell commands in a Workspace and asks before the
ones it cannot vouch for. It is here to show what
[`docs/20_approval.md`](../../docs/20_approval.md) is for: the write
capability, the gate, and the audit hook, with something using all
three.

The property the example is built around:

> a command runs with write access **if and only if** a human approved
> it.

## Why that is one property and not two

There are two obvious ways to keep a model from wrecking a workspace,
and only one of them is a boundary.

The first is to read the command and decide. That is a heuristic. It
was also the only tool available before the write capability existed,
and it was load-bearing, which is why its holes mattered: an early
version of the matcher in `src/approval-policy.ts` waved through `find
/workspace -mindepth 1 -delete`, because the verb was on the allowlist
and its flags were not.

The second is to withhold the capability. A command that was not
approved runs against a filesystem handle that has no write access, so
its writes fail whatever anybody believed about them. That is not a
guess, and it covers every caller rather than the model's path only.

Putting the second one underneath is what makes the first one safe to
keep. The matcher's job shrinks from *stopping* damage to *reducing
interruptions*, and its failure modes stop being symmetrical:

| The matcher is wrong about | What it costs |
|---|---|
| a read, calling it a write | one question nobody needed to answer |
| a write, calling it a read | the command runs read-only and fails visibly |

Neither loses a file. That is the only reason a regex-and-allowlist
matcher belongs anywhere near this decision, and it is why the two
decisions are wired to a single predicate in `src/agent.ts`:

```ts
writable: (input) => decideApproval(input, policy).needsApproval
```

which reads backwards until you notice when it runs. The AI SDK does
not call a tool's `execute` until approval has been granted, so asking
for write access exactly when approval was required means write access
and human attention cannot drift apart.

## The three backends, and why the answer differs

One Workspace, three backends, because a withheld capability is
enforced in a different place in each and that difference is worth
seeing.

| Backend | Runs | Refusal lands | Default rule |
|---|---|---|---|
| `worker-shell` | just-bash in a Dynamic Worker | inside the command, as `EROFS` | matcher |
| `worker-javascript` | an ECMAScript module in a Dynamic Worker | inside the module, the same way | always ask |
| `container-shell` | computerd over real coreutils | on write-back, as skipped entries | always ask |

Only `worker-shell` gets the matcher. The container runs real binaries
with public network access, and it is also where a refused write is
caught late — the command writes to the container's own copy of the
tree and the refusal arrives when those changes are pulled back — so it
is the worst place to be guessing. The JavaScript backend evaluates a
module whose effects are not a function of any verb, so there is
nothing for a matcher to be conservative about. Both are gated
outright.

## Architecture

```
you ──► cli/chat.mjs ──► Worker /c/<name>/agent
   ▲    (@ai-sdk/tui)         │
   │                          ▼
   └── approval prompt ── AgentExample DO
                              │  streamText + toolApproval
                              │
                    Workspace ├─ gate    (narrows write access)
                              ├─ audit   (records the outcome)
                              │
                              ├─► WorkerShellBackend      ──► Dynamic Worker
                              ├─► WorkerJavaScriptBackend ──► Dynamic Worker
                              └─► CloudflareContainerBackend ──► computerd
```

The gate and the audit hook are installed on the `Workspace`, not
around the agent. That is deliberate: the tool layer only covers the
model's path, while the seams also see the HTTP routes below and
anything added later.

The gate is not a second copy of the approval decision, and it cannot
be — a gate runs once the action exists, and there is nowhere to
suspend a running command that does not risk a partial result. What it
does is check the invariant from the other side. A command holding
write access should be one the matcher would have raised a question
about, since that is the only route to write access through the tool
layer. A recognized read that turns up wanting write access did not
come that way, and it is narrowed back to read-only, which costs it
nothing the matcher says it needed.

## The approval has to survive the trip

The conversation lives in the terminal, not in the Durable Object. An
answer to an approval therefore arrives as a claim the client makes
about something you supposedly did, and on that claim rests the write
access the command is about to get. So the worker signs every approval
it asks for, with a per-object key it keeps in storage, and the AI SDK
checks the signature before it will run the tool call. An approval that
was never issued has nothing to present.

The terminal UI drops the signature. Recording your answer replaces the
approval rather than adding to it, so what goes back is unsigned and
the turn dies with `missing signature`. That is true of every published
`@ai-sdk/tui` through 1.0.52, so the client wraps its transport to
remember the signatures it saw and put them back:
[`cli/approval-signatures.mjs`](cli/approval-signatures.mjs). The
repair belongs in the transport because a signature is not a secret —
it is a MAC only the worker can produce or check — and carrying one
across a turn it was always meant to survive gives the client nothing
it did not already have.

## Running it

```bash
npm install
npm run build                                    # from the repo root
npm run dev --workspace @example/computer-agent   # needs Docker for the container backend
```

`wrangler dev` builds the container image before it will start, so a
machine that cannot build it gets none of the example, including the
two backends that never touch a container. There is a second config
without the container for exactly that case:

```bash
npm run dev:local --workspace @example/computer-agent
```

Everything below works the same way under it, except that asking for
the `container-shell` backend fails: it is not there.

Then, in another terminal, put something in the workspace for the agent
to look at and start talking to it:

```bash
curl -X PUT --data-binary 'hello world' \
  localhost:8787/c/default/file/workspace/hello.txt

npm run chat --workspace @example/computer-agent
```

That `PUT` is itself a gated action — it goes through `Workspace.fs`,
so it shows up in the audit trail below as `fs.write`.

Two things to try, in this order:

```
cat the file at /workspace/hello.txt
```

Runs unattended. The matcher recognizes it, and it ran without write
access, which cost it nothing.

```
delete everything under /workspace
```

Stops and asks. Say no and nothing happens. Say yes and it runs with
the write access approval bought it.

The approval prompt shows the tool and the command. It does not show
the matcher's reason for asking, because an approval request has
nowhere to carry per-call text; the reason goes to the audit trail
instead:

```bash
curl -s localhost:8787/c/default/audit | jq
```

The HTTP surface, if you would rather drive it without a model:

```
PUT  /c/<name>/file/workspace/<path>   write a file
GET  /c/<name>/file/workspace/<path>   read a file
POST /c/<name>/exec                    run a command  {"command":…,"backend":…}
POST /c/<name>/agent                   one agent turn (UI message stream)
GET  /c/<name>/audit                   what the audit hook recorded
```

`POST /c/<name>/exec` is a caller the tool layer knows nothing about,
which makes it the quickest way to watch the gate work: ask it to run
`cat` and the audit trail shows the command allowed with `writable:
false`, because the gate took away access the command never needed.

## Tests

```bash
npm test --workspace @example/computer-agent
```

Three files, and the third is the interesting one.

`approval-policy.test.ts` pins what the matcher says. `agent.test.ts`
pins the invariant — that write access and approval are the same
decision — and the gate's narrowing.

`approval-policy.effects.test.ts` does something the other two cannot.
Assertions about a matcher are written by whoever wrote the matcher,
from the same blind spot, so they find the cases somebody thought of.
That file instead runs every command the policy would allow through
just-bash itself, against a filesystem that records every mutation,
and fails if any of them wrote — 630 commands generated, 475 allowed
unattended, none of them writing. Both real defects in this policy were
found by running the agent by hand and noticing, not by listing
examples, which is the argument for having it.

Its corpus derives the verbs from the allowlist rather than from a copy,
so a verb added to the policy later comes under test without anybody
remembering to add it.
