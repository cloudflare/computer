// Argv-driven artifacts surface.
//
// `runArtifactsCLI` is the dispatcher behind `ArtifactClient.cli`
// and behind the worker-backend's `artifacts` custom command in the
// shell isolate. It mirrors the shape of `git/cli.ts`: each
// subcommand delegates to the same `ArtifactClient` methods the
// typed surface uses, so the JS API and the CLI cannot drift.
//
// Output is machine-first. Reads and data-producing mutations print
// JSON on stdout; delete and revoke print a terse confirmation.
// Exit codes follow git/cli.ts: 0 ok, 1 operation failed, 129 for an
// argv-shape error (unknown flag, missing required value). Help is a
// first-class surface — `help`, `--help`, `-h`, and per-group
// `--help` all print agent-readable documentation.

import type { ArtifactClient } from "./client.js";
import { parseDuration } from "./duration.js";
import { ArtifactError } from "./errors.js";
import type { ArtifactScope } from "./types.js";

/**
 * Git seam for the `create` shorthand. The artifacts package owns no
 * git; the worker backend supplies this closure, bound to the same
 * `workspace.git.cli(...)` the `git` shell command uses, so `create`
 * can register the remote without the package depending on git.
 *
 * Returns `ok` on success. On failure, `exists: true` distinguishes a
 * remote-name collision (recoverable with `--force`) from any other
 * git error, so the dispatcher can point the caller at the right fix.
 * When `force` is set the implementation updates the existing remote
 * (the moral equivalent of `git remote set-url`) rather than failing.
 */
export type RemoteAddFn = (opts: {
  name: string;
  url: string;
  force?: boolean;
}) => Promise<{ ok: boolean; exists?: boolean; message?: string }>;

export interface ArtifactsCLIInput {
  /** Argv as seen by the shell command. `argv[0]` is the group. */
  argv: string[];
  /** Environment variables. Reserved for future use. */
  env?: Record<string, string>;
  /**
   * Optional git seam used only by the `create` shorthand to register
   * the remote. When absent, `create` skips the git step and instead
   * reports a ready-to-run `git remote add` line.
   */
  remoteAdd?: RemoteAddFn;
}

export interface ArtifactsCLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runArtifactsCLI(
  client: ArtifactClient,
  input: ArtifactsCLIInput,
): Promise<ArtifactsCLIResult> {
  const argv = input.argv;
  // Help describes the scoping the client actually applies, so every
  // help path is told whether this client sits in one session or
  // spans the namespace.
  const scoped = client.sessionId !== undefined;
  if (argv.length === 0) {
    // Bare invocation: print help but signal misuse, the way `git`
    // with no args exits non-zero.
    return { stdout: topLevelHelp(scoped), stderr: "", exitCode: 1 };
  }
  const [group, ...rest] = argv;
  switch (group) {
    case "help":
    case "--help":
    case "-h":
      return ok(topLevelHelp(scoped));
    case "create":
      return await runCreate(client, rest, input.remoteAdd);
    case "share":
      return await runShare(client, rest);
    case "repo":
      return await runRepo(client, rest, scoped);
    case "token":
      return await runToken(client, rest, scoped);
    default:
      return fail(`artifacts: '${group}' is not an artifacts command. See 'artifacts help'.`);
  }
}

// ---------------------------------------------------------------
// create shorthand
// ---------------------------------------------------------------
//
// `create` composes the three steps a caller otherwise runs by hand:
// create the repo, mint a git token, and register a git remote whose
// URL carries that token. It is a convenience over the `repo` and
// `token` primitives, not a replacement — those still exist for the
// uncomposed cases.
//
// The three steps are sequential side effects, so a failure can leave
// a repo (and token) behind. `--force` makes the command converge:
// an existing repo is reused rather than treated as a collision, and
// an existing remote is updated rather than refused. Without it,
// either pre-existing piece is a hard error whose message points at
// `--force`, so a half-finished previous run has a clear recovery.

async function runCreate(
  client: ArtifactClient,
  args: string[],
  remoteAdd: RemoteAddFn | undefined,
): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {
    scope: { kind: "value" },
    ttl: { kind: "value" },
    remote: { kind: "value" },
    "default-branch": { kind: "value" },
    description: { kind: "value" },
    force: { kind: "bool" },
  });
  if ("error" in parsed) return argvError("create", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("create", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("create", `unexpected argument '${parsed.positional[1]}'`);
  }

  // Scope defaults to write: the point of the shorthand is to set up a
  // remote you can push to. A read default would register an origin
  // that rejects the first push.
  let scope: ArtifactScope = "write";
  if (parsed.flags.scope !== undefined) {
    const s = parsed.flags.scope as string;
    if (s !== "read" && s !== "write") {
      return argvError("create", `--scope must be 'read' or 'write' (got '${s}')`);
    }
    scope = s;
  }

  let ttl: number | undefined;
  if (parsed.flags.ttl !== undefined) {
    try {
      ttl = parseDuration(parsed.flags.ttl as string);
    } catch (cause) {
      return argvError("create", cause instanceof Error ? cause.message : String(cause));
    }
  }

  const force = parsed.flags.force === true;
  const gitRemote = (parsed.flags.remote as string | undefined) ?? name;
  const description = parsed.flags.description as string | undefined;
  const setDefaultBranch = parsed.flags["default-branch"] as string | undefined;

  // Step 1: create the repo, or adopt an existing one under --force.
  // `get` and `create` return different shapes; only the fields the
  // shorthand reports are needed, and both carry those.
  let info: { name: string; remote: string; defaultBranch: string };
  try {
    const existing = await tryGet(client, name);
    if (existing !== undefined) {
      if (!force) {
        return fail(
          `artifacts create: repo '${name}' already exists; re-run with --force to reuse it and refresh the remote`,
        );
      }
      info = existing;
    } else {
      info = await client.create(name, { description, setDefaultBranch });
    }
  } catch (cause) {
    return mapError("create", cause);
  }

  // Step 2: mint the token and compose the credentialed remote.
  let token: ArtifactsCreateTokenResult;
  let credentialedRemote: string;
  try {
    token = await client.createToken(name, scope, ttl);
    credentialedRemote = credentialURL(info.remote, token.plaintext);
  } catch (cause) {
    return mapError("create", cause);
  }

  // Step 3: register the git remote, if a seam was wired.
  let remoteRegistered = false;
  let remoteAddCommand: string | undefined;
  if (remoteAdd === undefined) {
    remoteAddCommand = `git remote add ${gitRemote} ${credentialedRemote}`;
  } else {
    const result = await remoteAdd({ name: gitRemote, url: credentialedRemote, force });
    if (!result.ok) {
      if (result.exists === true && !force) {
        return fail(
          `artifacts create: remote '${gitRemote}' already exists; re-run with --force to update its URL`,
        );
      }
      return fail(
        `artifacts create: could not register remote '${gitRemote}'${result.message ? `: ${result.message}` : ""}`,
      );
    }
    remoteRegistered = true;
  }

  return ok(
    json({
      name: info.name,
      remote: info.remote,
      credentialedRemote,
      defaultBranch: info.defaultBranch,
      gitRemote,
      scope,
      token: token.plaintext,
      tokenExpiresAt: token.expiresAt,
      remoteRegistered,
      ...(remoteAddCommand !== undefined ? { remoteAddCommand } : {}),
    }),
  );
}

// ---------------------------------------------------------------
// share shorthand
// ---------------------------------------------------------------
//
// `share` mints a token for an existing repo and prints just the
// credentialed remote URL — a single clone/push-ready string, no
// JSON envelope. It is the read-side counterpart to `create`: where
// `create` sets up a repo and a push remote, `share` hands out a URL
// someone else can clone from. Scope defaults to read since that is
// the common case for handing a link to a consumer.

async function runShare(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {
    scope: { kind: "value" },
    ttl: { kind: "value" },
  });
  if ("error" in parsed) return argvError("share", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("share", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("share", `unexpected argument '${parsed.positional[1]}'`);
  }

  let scope: ArtifactScope = "read";
  if (parsed.flags.scope !== undefined) {
    const s = parsed.flags.scope as string;
    if (s !== "read" && s !== "write") {
      return argvError("share", `--scope must be 'read' or 'write' (got '${s}')`);
    }
    scope = s;
  }

  let ttl: number | undefined;
  if (parsed.flags.ttl !== undefined) {
    try {
      ttl = parseDuration(parsed.flags.ttl as string);
    } catch (cause) {
      return argvError("share", cause instanceof Error ? cause.message : String(cause));
    }
  }

  try {
    // Resolve the repo first so a missing repo fails before a token
    // is minted.
    const info = await client.get(name);
    const token = await client.createToken(name, scope, ttl);
    return ok(`${credentialURL(info.remote, token.plaintext)}\n`);
  } catch (cause) {
    return mapError("share", cause);
  }
}

/** Resolve a repo, returning undefined on a clean not-found miss. */
async function tryGet(
  client: ArtifactClient,
  name: string,
): Promise<ArtifactsRepoInfo | undefined> {
  try {
    return await client.get(name);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
}

/** True when a thrown error is a repo-not-found miss from either layer. */
function isNotFound(cause: unknown): boolean {
  if (cause instanceof ArtifactError) return cause.code === "ENOTFOUND";
  // The binding raises its own ArtifactsError with code NOT_FOUND.
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "NOT_FOUND"
  );
}

/**
 * Fold a git token into a remote URL as basic-auth, yielding a
 * clone/push-ready URL. The username is the conventional `x`; the
 * token is the password.
 *
 * The token plaintext carries a trailing `?expires=<ts>` hint that is
 * not part of the credential, so strip it before use. The userinfo
 * is spliced in textually rather than through `new URL`: the remote
 * is already a well-formed absolute URL, and round-tripping it
 * through the URL parser is both unnecessary and fragile under
 * workerd, whose parser rejects inputs Node's accepts. Only the
 * secret needs encoding, so encode just that.
 */
export function credentialURL(remote: string, token: string): string {
  const secret = encodeURIComponent(token.split("?expires=", 1)[0]);
  const sep = remote.indexOf("://");
  if (sep === -1) return remote;
  const scheme = remote.slice(0, sep + 3);
  return `${scheme}x:${secret}@${remote.slice(sep + 3)}`;
}

// ---------------------------------------------------------------
// repo group
// ---------------------------------------------------------------

async function runRepo(
  client: ArtifactClient,
  args: string[],
  scoped: boolean,
): Promise<ArtifactsCLIResult> {
  if (args.length === 0) {
    return { stdout: repoHelp(scoped), stderr: "", exitCode: 1 };
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return ok(repoHelp(scoped));
    case "create":
      return await runRepoCreate(client, rest);
    case "get":
      return await runRepoGet(client, rest);
    case "list":
      return await runRepoList(client, rest);
    case "delete":
      return await runRepoDelete(client, rest);
    case "import":
      return await runRepoImport(client, rest);
    default:
      return fail(
        `artifacts repo: '${sub}' is not a repo subcommand. See 'artifacts repo --help'.`,
      );
  }
}

async function runRepoCreate(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {
    description: { kind: "value" },
    "default-branch": { kind: "value" },
    "read-only": { kind: "bool" },
  });
  if ("error" in parsed) return argvError("repo create", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("repo create", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("repo create", `unexpected argument '${parsed.positional[1]}'`);
  }
  try {
    const result = await client.create(name, {
      description: parsed.flags.description as string | undefined,
      setDefaultBranch: parsed.flags["default-branch"] as string | undefined,
      readOnly: parsed.flags["read-only"] === true,
    });
    return ok(json(result));
  } catch (cause) {
    return mapError("repo create", cause);
  }
}

async function runRepoGet(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("repo get", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("repo get", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("repo get", `unexpected argument '${parsed.positional[1]}'`);
  }
  try {
    return ok(json(await client.get(name)));
  } catch (cause) {
    return mapError("repo get", cause);
  }
}

async function runRepoList(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("repo list", parsed.error);
  if (parsed.positional.length > 0) {
    return argvError("repo list", `unexpected argument '${parsed.positional[0]}'`);
  }
  try {
    return ok(json(await client.list()));
  } catch (cause) {
    return mapError("repo list", cause);
  }
}

async function runRepoDelete(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("repo delete", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("repo delete", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("repo delete", `unexpected argument '${parsed.positional[1]}'`);
  }
  try {
    const deleted = await client.delete(name);
    if (!deleted) {
      return fail(`artifacts repo delete: no such repo '${name}'`);
    }
    return ok(`Deleted ${name}\n`);
  } catch (cause) {
    return mapError("repo delete", cause);
  }
}

async function runRepoImport(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {
    url: { kind: "value" },
    branch: { kind: "value" },
    depth: { kind: "value" },
    "read-only": { kind: "bool" },
    description: { kind: "value" },
  });
  if ("error" in parsed) return argvError("repo import", parsed.error);
  const name = parsed.positional[0];
  if (name === undefined) return argvError("repo import", "missing <name>");
  if (parsed.positional.length > 1) {
    return argvError("repo import", `unexpected argument '${parsed.positional[1]}'`);
  }
  const url = parsed.flags.url as string | undefined;
  if (url === undefined) return argvError("repo import", "missing --url");

  let depth: number | undefined;
  if (parsed.flags.depth !== undefined) {
    const n = Number.parseInt(parsed.flags.depth as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      return argvError(
        "repo import",
        `--depth requires a positive integer (got ${JSON.stringify(parsed.flags.depth)})`,
      );
    }
    depth = n;
  }

  try {
    const result = await client.import(
      name,
      { url, branch: parsed.flags.branch as string | undefined, depth },
      {
        description: parsed.flags.description as string | undefined,
        readOnly: parsed.flags["read-only"] === true,
      },
    );
    return ok(json(result));
  } catch (cause) {
    return mapError("repo import", cause);
  }
}

// ---------------------------------------------------------------
// token group
// ---------------------------------------------------------------

async function runToken(
  client: ArtifactClient,
  args: string[],
  scoped: boolean,
): Promise<ArtifactsCLIResult> {
  if (args.length === 0) {
    return { stdout: tokenHelp(scoped), stderr: "", exitCode: 1 };
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return ok(tokenHelp(scoped));
    case "create":
      return await runTokenCreate(client, rest);
    case "list":
      return await runTokenList(client, rest);
    case "get":
      return await runTokenGet(client, rest);
    case "delete":
    case "revoke":
      return await runTokenDelete(client, rest);
    default:
      return fail(
        `artifacts token: '${sub}' is not a token subcommand. See 'artifacts token --help'.`,
      );
  }
}

async function runTokenCreate(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {
    scope: { kind: "value" },
    ttl: { kind: "value" },
  });
  if ("error" in parsed) return argvError("token create", parsed.error);
  const repo = parsed.positional[0];
  if (repo === undefined) return argvError("token create", "missing <repo>");
  if (parsed.positional.length > 1) {
    return argvError("token create", `unexpected argument '${parsed.positional[1]}'`);
  }

  let scope: ArtifactScope | undefined;
  if (parsed.flags.scope !== undefined) {
    const s = parsed.flags.scope as string;
    if (s !== "read" && s !== "write") {
      return argvError("token create", `--scope must be 'read' or 'write' (got '${s}')`);
    }
    scope = s;
  }

  let ttl: number | undefined;
  if (parsed.flags.ttl !== undefined) {
    try {
      ttl = parseDuration(parsed.flags.ttl as string);
    } catch (cause) {
      return argvError("token create", cause instanceof Error ? cause.message : String(cause));
    }
  }

  try {
    return ok(json(await client.createToken(repo, scope, ttl)));
  } catch (cause) {
    return mapError("token create", cause);
  }
}

async function runTokenList(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("token list", parsed.error);
  const repo = parsed.positional[0];
  if (repo === undefined) return argvError("token list", "missing <repo>");
  if (parsed.positional.length > 1) {
    return argvError("token list", `unexpected argument '${parsed.positional[1]}'`);
  }
  try {
    return ok(json(await client.listTokens(repo)));
  } catch (cause) {
    return mapError("token list", cause);
  }
}

async function runTokenGet(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("token get", parsed.error);
  const [repo, id] = parsed.positional;
  if (repo === undefined) return argvError("token get", "missing <repo>");
  if (id === undefined) return argvError("token get", "missing <id>");
  if (parsed.positional.length > 2) {
    return argvError("token get", `unexpected argument '${parsed.positional[2]}'`);
  }
  try {
    return ok(json(await client.getToken(repo, id)));
  } catch (cause) {
    return mapError("token get", cause);
  }
}

async function runTokenDelete(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) return argvError("token delete", parsed.error);
  const [repo, tokenOrId] = parsed.positional;
  if (repo === undefined) return argvError("token delete", "missing <repo>");
  if (tokenOrId === undefined) return argvError("token delete", "missing <id>");
  if (parsed.positional.length > 2) {
    return argvError("token delete", `unexpected argument '${parsed.positional[2]}'`);
  }
  try {
    const revoked = await client.revokeToken(repo, tokenOrId);
    if (!revoked) {
      return fail(`artifacts token delete: could not revoke token in '${repo}'`);
    }
    return ok("Revoked token\n");
  } catch (cause) {
    return mapError("token delete", cause);
  }
}

// ---------------------------------------------------------------
// help text
// ---------------------------------------------------------------
//
// The two name paragraphs are the only thing scoping changes. A
// client bound to a session works in local names; one bound to the
// namespace works in stored names and sees every session's
// repositories. Help states whichever is true, because a consumer
// that believes the wrong one addresses the wrong repository.

const SCOPED_NAMES = `Every repository name you pass is implicitly scoped to this
session: the name 'starter' addresses the repo stored as
'<session>__starter'. You only ever work in local names; the session
prefix is added on the way in and stripped on the way out. 'repo
list' shows only this session's repositories.
`;

const UNSCOPED_NAMES = `This client is not scoped to a session: names are the ones the
namespace stores, with nothing added on the way in or stripped on
the way out. 'repo list' shows every repository in the namespace,
including those a session owns (stored as '<session>__<name>'), and
any of them can be read, written to, or deleted under that name.
`;

function topLevelHelp(scoped: boolean): string {
  return `usage: artifacts <command> [<args>]

Manage Cloudflare Artifacts repositories and git tokens.

${scoped ? SCOPED_NAMES : UNSCOPED_NAMES}
Commands:
   create  Create a repo, mint a token, and register a git remote.
   share   Mint a token and print one clone-ready remote URL.
   repo    Manage repositories (create, get, list, delete, import).
   token   Manage git tokens for a repository.
   help    Show this help.

Run 'artifacts repo --help' or 'artifacts token --help' for the
subcommands in each group.

The 'create' shorthand composes the common setup in one step:

   artifacts create <name> [--scope read|write] [--ttl <dur>]
                           [--remote <name>] [--default-branch <b>]
                           [--description <text>] [--force]

It creates the repo, mints a git token (scope defaults to write),
and registers a git remote whose URL carries that token. --remote
names the git remote (default: <name>). --ttl accepts seconds or a
unit-suffixed duration like 30s, 5m, 1h, 2h30m. The credentialed
remote URL it prints is a secret. Re-running fails if the repo or
remote already exists; --force reuses the repo and updates the
remote so a half-finished run can be recovered.

The 'share' shorthand is the read-side counterpart:

   artifacts share <name> [--scope read|write] [--ttl <dur>]

It mints a token for an existing repo and prints just the
credentialed remote URL on stdout — one clone/push-ready string, no
JSON envelope. Scope defaults to read. The whole URL is a secret.

Output: reads and creates print JSON on stdout; 'share' prints a
single URL; delete and revoke print a one-line confirmation. Exit
codes: 0 success, 1 the operation failed, 129 a malformed command
line.

Secrets: 'create', 'share', and 'token create' all surface a token
(as plaintext, or embedded in the URL 'create'/'share' print).
'token list' and 'token get' show metadata only.
`;
}

function repoHelp(scoped: boolean): string {
  return `usage: artifacts repo <subcommand> [<args>]

${
  scoped
    ? "All names are session-scoped; pass local names only."
    : "Names are namespace-wide; pass the name a repository is stored under."
}

   repo create <name> [--description <text>] [--default-branch <branch>] [--read-only]
       Create a repository. Prints JSON: { name, remote, defaultBranch, token }.
       The token is an initial git token — treat it as a secret.

   repo get <name>
       Print JSON metadata for a repository: ArtifactsRepoInfo with a local name.

   repo list
       Print a JSON array of ${scoped ? "this session's" : "the namespace's"} repository metadata (without remote).

   repo delete <name>
       Delete a repository. Prints a one-line confirmation.

   repo import <name> --url <https-url> [--branch <branch>] [--depth <n>] [--read-only] [--description <text>]
       Import an external git remote into a new repository.

Example:
   artifacts repo create build-cache --description "CI artifacts"
   artifacts repo list
`;
}

function tokenHelp(scoped: boolean): string {
  return `usage: artifacts token <subcommand> [<args>]

Tokens authenticate git operations against a repository's remote.
${
  scoped
    ? "The <repo> argument is a session-scoped local name."
    : "The <repo> argument is the name a repository is stored under."
}

   token create <repo> [--scope read|write] [--ttl <dur>]
       Mint a token. Prints JSON: { id, plaintext, scope, expiresAt }.
       The plaintext is shown ONCE here and nowhere else — capture it.
       --scope defaults to write. --ttl accepts seconds or a unit-
       suffixed duration (30s, 5m, 1h, 2h30m); defaults to the
       service default.

   token list <repo>
       Print JSON: { total, tokens: [{ id, scope, state, ... }] }.
       Metadata only; no plaintext.

   token get <repo> <id>
       Print a single token's metadata by id. No plaintext.

   token delete <repo> <id|plaintext>   (alias: revoke)
       Revoke a token. Prints a one-line confirmation.

Example:
   artifacts token create build-cache --scope read --ttl 3600
`;
}

// ---------------------------------------------------------------
// result + error helpers
// ---------------------------------------------------------------

function ok(stdout: string): ArtifactsCLIResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(message: string): ArtifactsCLIResult {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}

function argvError(subcommand: string, message: string): ArtifactsCLIResult {
  return { stdout: "", stderr: `artifacts ${subcommand}: ${message}\n`, exitCode: 129 };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Map a thrown error to the standard `artifacts <subcommand>:
 * <message>` framing at exit 1. ArtifactError subclasses carry a
 * clean message; anything else stringifies its cause.
 */
function mapError(subcommand: string, cause: unknown): ArtifactsCLIResult {
  if (cause instanceof ArtifactError) {
    return { stdout: "", stderr: `artifacts ${subcommand}: ${cause.message}\n`, exitCode: 1 };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { stdout: "", stderr: `artifacts ${subcommand}: ${message}\n`, exitCode: 1 };
}

// ---------------------------------------------------------------
// flag parser
// ---------------------------------------------------------------
//
// A small flag-table-driven parser. `value` flags consume the next
// argv token (or an `=`-joined value); `bool` flags are presence-
// only. Everything not recognised as a flag is positional. Unknown
// flags and missing values are argv-shape errors.

type FlagKind = "value" | "bool";
interface FlagSpec {
  kind: FlagKind;
}
type FlagTable = Record<string, FlagSpec>;

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseFlags(args: string[], table: FlagTable): ParsedFlags | { error: string } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      // Everything after `--` is positional.
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const spec = table[name];
      if (!spec) return { error: `unknown option '--${name}'` };
      if (spec.kind === "bool") {
        if (eq !== -1) return { error: `option '--${name}' takes no value` };
        flags[name] = true;
        continue;
      }
      // value flag
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next === undefined) return { error: `option '--${name}' requires a value` };
      flags[name] = next;
      i++;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}
