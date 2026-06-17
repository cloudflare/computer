# 15. Artifacts interface

> [!NOTE]
> This doc describes shipped code in
> `packages/workspace/src/artifacts/` and the `artifacts` custom
> command in `packages/workspace/src/backends/worker/`.

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
is versioned, Git-speaking repository storage. A Worker reaches it
through a namespace binding (`env.ARTIFACTS`) that can create,
inspect, import, and delete repositories and mint Git tokens scoped
to a repository.

`@cloudflare/workspace/artifacts` wraps that binding with a
**session-scoped** facade. `createArtifact(binding, sessionId)`
binds a namespace binding and a session id once and returns a client
whose every operation is implicitly scoped to that session.

```ts
import { createArtifact } from "@cloudflare/workspace/artifacts";

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
| `cli(input)` | The argv door (below). |

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

`artifacts.cli({ argv })` dispatches two groups, `repo` and `token`.

```
artifacts help                       # top-level help
artifacts --help | -h                # alias for help
artifacts repo --help                # repo group help
artifacts token --help               # token group help

artifacts repo create <name> [--description D] [--default-branch B] [--read-only]
artifacts repo get <name>
artifacts repo list
artifacts repo delete <name>
artifacts repo import <name> --url U [--branch B] [--depth N] [--read-only] [--description D]

artifacts token create <repo> [--scope read|write] [--ttl SECONDS]
artifacts token list <repo>
artifacts token get <repo> <id>
artifacts token delete <repo> <id|plaintext>   # alias: revoke
```

Output is machine-first. Reads and data-producing mutations
(`create`, `get`, `list`, `import`, `token create/list/get`) print
JSON on stdout. `delete` and `token delete` print a one-line
confirmation.

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

`token create` is the only command that prints a token's
`plaintext`, and `create` / `import` are the only commands that
return an initial `token`. `token list` and `token get` show
metadata only. Capture a token's plaintext when it is minted; it is
not retrievable afterward.

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
