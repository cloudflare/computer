# 15. Artifacts interface

> [!NOTE]
> This doc describes shipped code in
> `packages/computer/src/artifacts/` and the `artifacts` custom
> command in `packages/computer/src/backends/worker/`.

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
is versioned, Git-speaking repository storage. A Worker reaches it
through a namespace binding (`env.ARTIFACTS`) that can create,
inspect, import, and delete repositories and mint Git tokens scoped
to a repository.

`@cloudflare/computer/artifacts` wraps that binding with a
**session-scoped** facade. `createArtifact(binding, sessionId)`
binds a namespace binding and a session id once and returns a client
whose every operation is implicitly scoped to that session.

```ts
import { createArtifact } from "@cloudflare/computer/artifacts";

const artifacts = createArtifact(env.ARTIFACTS, agentId);

const repo = await artifacts.create("build-cache", {
  description: "CI artifacts for this agent",
});
// repo.name    -> "build-cache"  (local, unscoped)
// repo.remote  -> "https://.../<agentId>__build-cache.git"
// repo.token   -> initial git token (a secret)
```

## Session scoping

The session id is a **name prefix**. A repository the caller names
`build-cache` is stored in the namespace as
`${sessionId}__build-cache`. The caller never types the prefix: it
is added on the way into the binding and stripped on the way back
out, so every name a caller passes or receives is local.

- `create("foo")` stores `sessionId__foo`; the returned `name` is
  `foo`.
- `get("foo")`, `delete("foo")`, and the token methods all address
  `sessionId__foo`.
- `list()` returns only the repositories that belong to the session,
  each with the prefix removed. Repositories from other sessions in
  the same namespace are filtered out.

Artifacts repository names may contain letters, digits, `.`, `_`,
and `-`, but not `/`. The scope separator is therefore a double
underscore (`__`). Both the session id and the local name forbid
that separator, so the split is unambiguous. An empty, malformed, or
separator-bearing session id throws `InvalidSessionIdError` at
construction; the same constraint on a repo name throws
`InvalidRepoNameError`.

This lets one namespace host many isolated sessions — one per agent,
user, or task — without the caller managing prefixes by hand, and
without one session enumerating or colliding with another's repos.

## Two doors into the same implementation

Like `workspace.git`, the artifacts surface has a typed API and an
argv-driven CLI backed by one implementation, so they cannot drift.

- A typed JavaScript API — `artifacts.create({...})`,
  `artifacts.createToken(...)`, and so on. Object-options in,
  structured values out.
- An argv-driven entry point — `artifacts.cli({ argv, env })`.
  Every flag-shape decision lives in `artifacts/cli.ts`; the typed
  methods and the CLI route to the same client.

The exceptions are the CLI's top-level shorthands. `create` composes
`create` and `createToken` and then registers a git remote; `share`
composes `get` and `createToken` and prints a single credentialed
URL. These compositions are CLI-only — there is no single typed
method for them, and `create`'s git step rides on an injected seam
(below) rather than a client method. The pieces they compose are
still the same client methods, so the two doors do not drift on the
parts they share.

## Typed surface

`createArtifact(binding, sessionId)` returns an `ArtifactClient`:

| Method | Purpose |
| --- | --- |
| `create(name, opts?)` | Create a repo. Returns `{ name, remote, defaultBranch, token }` with a local `name`. |
| `get(name)` | Resolve full `ArtifactsRepoInfo` metadata with a local `name`. Throws if missing. |
| `list()` | The session's repo summaries: `Omit<ArtifactsRepoInfo, "remote">[]`, each with a local `name`. Walks every page. |
| `import(name, source, opts?)` | Import an external git remote into a session repo. |
| `delete(name)` | Delete a repo. Returns `false` when it does not exist. |
| `createToken(name, scope?, ttl?)` | Mint a git token. Returns `{ id, plaintext, scope, expiresAt }`. |
| `listTokens(name)` | A repo's token page (metadata only). |
| `getToken(name, id)` | One token's metadata from that page. Throws `NotFoundError` on a miss. |
| `revokeToken(name, tokenOrId)` | Revoke a token. Returns `false` on a miss. |
| `cli(input)` | The argv door (below). `input` may also carry a `remoteAdd` seam used only by the CLI `create` shorthand. |

`opts` for `create` carries `description`, `readOnly`, and
`setDefaultBranch`. `source` for `import` carries `url`, `branch`,
and `depth`; its `opts` carries `description` and `readOnly`. `scope`
is `"read"` or `"write"` (default `"write"`); `ttl` is in seconds.

### Pagination

`list()` exposes no cursor. It walks the binding's pages internally
until they are exhausted and returns the full session-scoped set. The
page size is an internal constant, not a caller-facing cap.

### `getToken` and the binding

The binding has no direct token accessor. It also exposes
`listTokens()` without a caller-supplied cursor, even though the
result type carries a page of tokens plus a `total`. So
`getToken(name, id)` filters the returned page and raises
`NotFoundError` when no token in that page matches.

## CLI surface

`artifacts.cli({ argv })` dispatches two top-level shorthands,
`create` and `share`, plus two groups, `repo` and `token`.

```
artifacts help                       # top-level help
artifacts --help | -h                # alias for help
artifacts repo --help                # repo group help
artifacts token --help               # token group help

artifacts create <name> [--scope read|write] [--ttl DUR] [--remote NAME] \
                        [--default-branch B] [--description D] [--force]
artifacts share <name> [--scope read|write] [--ttl DUR]

artifacts repo create <name> [--description D] [--default-branch B] [--read-only]
artifacts repo get <name>
artifacts repo list
artifacts repo delete <name>
artifacts repo import <name> --url U [--branch B] [--depth N] [--read-only] [--description D]

artifacts token create <repo> [--scope read|write] [--ttl DUR]
artifacts token list <repo>
artifacts token get <repo> <id>
artifacts token delete <repo> <id|plaintext>   # alias: revoke
```

Output is machine-first. Reads and data-producing mutations
(`create`, `repo create`, `get`, `list`, `import`,
`token create/list/get`) print JSON on stdout. `share` prints a
single credentialed remote URL. `delete` and `token delete` print a
one-line confirmation.

### The `create` shorthand

`artifacts create <name>` composes the three steps a caller
otherwise runs by hand: it creates the repo, mints a git token, and
registers a git remote whose URL carries that token. It is a
convenience over the `repo` and `token` primitives, which remain for
the uncomposed cases.

- `--scope` defaults to `write`: the point of the shorthand is a
  remote you can push to. A `read` default would register an origin
  that rejects the first push.
- `--remote` names the git remote to register; it defaults to
  `<name>`, so `--remote origin` is the common override.
- `--ttl` accepts either bare seconds or a unit-suffixed duration —
  `30s`, `5m`, `1h`, `2h30m`, `1d`. The same grammar applies to
  `token create --ttl`. A bare integer is still seconds, so existing
  invocations keep working.

The printed JSON carries the bare `remote` (non-secret), the
`credentialedRemote` (the push/clone-ready URL with the token folded
in as basic-auth — a secret), `defaultBranch`, the `gitRemote` name,
the `scope`, the token `plaintext`, and `remoteRegistered`. When the
shell wires no git seam, `remoteRegistered` is `false` and a
`remoteAddCommand` field carries a ready-to-run `git remote add`
line instead.

The three steps are sequential side effects, so a failure can leave
a repo (and token) behind. Re-running a bare `create` then fails
because the repo already exists. `--force` is the recovery path: it
reuses an existing repo rather than treating it as a collision, and
updates an existing git remote rather than refusing it. Without
`--force`, either pre-existing piece is a hard error (exit 1) whose
message names `--force`. Each `--force` run mints a fresh token; the
prior token keeps working until its TTL.

The git step is injected. The artifacts package owns no git: the
worker backend hands the CLI a `remoteAdd` closure backed by the
same `workspace.git.cli(...)` the built-in `git` command uses. The
typed `create`/`createToken` methods never learn about git, so the
JS API and the CLI cannot drift.

### The `share` shorthand

`artifacts share <name>` is the read-side counterpart to `create`.
It mints a git token for an existing repo and prints just the
credentialed remote URL on stdout — one clone/push-ready string, no
JSON envelope — so a caller can hand off a link without parsing
output or hand-building the URL.

- `--scope` defaults to `read`: the common case is handing a
  fetch-only link to a consumer. Pass `--scope write` for a
  pushable URL.
- `--ttl` takes the same duration grammar as `create`.

The repo must already exist; a missing repo is a hard error (exit 1)
and no token is minted. The whole printed URL is a secret — it
carries a live token. Each call mints a fresh token, so revoking one
shared link does not disturb others.

Help is a first-class, agent-readable surface. `help`, `--help`,
`-h`, and each group's `--help` print documentation that spells out
the session-scoping contract and the secret-handling rules. A bare
`artifacts` prints the top-level help and exits non-zero, the way
`git` with no args does.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The operation failed (repo not found, name collision, unknown subcommand, token miss). |
| `129` | Malformed command line (unknown flag, missing required value or positional). |

### Secrets

`token create` and the `create` shorthand print a token's
`plaintext`; `share` prints a remote URL with a live token embedded;
and `repo create` / `import` return an initial `token`.
The `create` shorthand additionally prints a `credentialedRemote`
URL with that token embedded — treat the whole URL as a secret.
`token list` and `token get` show metadata only. Capture a token's
plaintext when it is minted; it is not retrievable afterward.

## Running the CLI inside the shell

The worker backend's shell isolate always exposes an `artifacts`
command. The command forwards through the `WorkspaceStub` returned by
`getWorkspace()` and calls `workspace.artifacts.cli(...)`, matching
the built-in `git` command's `workspace.git.cli(...)` path.

A host durable object wires the command by passing its
`env.ARTIFACTS` binding to `Workspace`:

```ts
export class MyAgent extends DurableObject<Env> {
  #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      sessionId: ctx.id.toString(),
      artifacts: { binding: env.ARTIFACTS },
      backends: [new WorkerBackend(/* ... */)],
    });
  }
}
```

When `artifacts` is omitted from `Workspace`, the command still
exists, but operations fail with a clear "Workspace Artifacts binding
is not configured" error.

The binding stanza in the consumer's Wrangler config:

```jsonc
{
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]
}
```

Inside `bash.exec`, `artifacts repo list` then forwards across the
loopback to the client's `cli(...)`. The shell isolate has no
network of its own; the binding call happens host-side, the same way
network-bound `git` subcommands do.

The `create` shorthand's git step rides the same wiring. The shell's
`artifacts` command hands the CLI a `remoteAdd` closure backed by
`workspace.git.cli(...)`, bound to the shell's working directory, so
the remote is registered host-side in the repo the caller is sitting
in. No extra binding is needed beyond the git surface the
`WorkspaceStub` already exposes.

## Types

The binding and its wire shapes are the global types from
`@cloudflare/workers-types`: `Artifacts` (the namespace binding),
`ArtifactsRepo` (the repo handle), `ArtifactsCreateRepoResult`,
`ArtifactsRepoInfo`, `ArtifactsTokenInfo`, `ArtifactsError`, and so
on. `createArtifact(binding, sessionId)` takes an `Artifacts` and
returns metadata in those same shapes — the facade adds session
scoping, it does not redeclare the protocol. Workers consumers get
the globals from their own `@cloudflare/workers-types` setup, and
this package's typecheck uses the same source of truth.

The in-memory `FakeArtifactsBinding` the tests run against
`implements Artifacts`, so the type checker holds the fake to the
real interface; a drift in the published shape fails the build
rather than passing green.

The facade covers the repository and token lifecycle. The binding's
`fork` is intentionally out of scope for now.
