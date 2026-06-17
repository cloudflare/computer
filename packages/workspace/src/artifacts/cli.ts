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
import { ArtifactError } from "./errors.js";
import type { ArtifactScope } from "./types.js";

export interface ArtifactsCLIInput {
  /** Argv as seen by the shell command. `argv[0]` is the group. */
  argv: string[];
  /** Environment variables. Reserved for future use. */
  env?: Record<string, string>;
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
  if (argv.length === 0) {
    // Bare invocation: print help but signal misuse, the way `git`
    // with no args exits non-zero.
    return { stdout: topLevelHelp(), stderr: "", exitCode: 1 };
  }
  const [group, ...rest] = argv;
  switch (group) {
    case "help":
    case "--help":
    case "-h":
      return ok(topLevelHelp());
    case "repo":
      return await runRepo(client, rest);
    case "token":
      return await runToken(client, rest);
    default:
      return fail(`artifacts: '${group}' is not an artifacts command. See 'artifacts help'.`);
  }
}

// ---------------------------------------------------------------
// repo group
// ---------------------------------------------------------------

async function runRepo(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  if (args.length === 0) {
    return { stdout: repoHelp(), stderr: "", exitCode: 1 };
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return ok(repoHelp());
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

async function runToken(client: ArtifactClient, args: string[]): Promise<ArtifactsCLIResult> {
  if (args.length === 0) {
    return { stdout: tokenHelp(), stderr: "", exitCode: 1 };
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return ok(tokenHelp());
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
    const n = Number.parseInt(parsed.flags.ttl as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      return argvError(
        "token create",
        `--ttl requires a positive integer (got ${JSON.stringify(parsed.flags.ttl)})`,
      );
    }
    ttl = n;
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

function topLevelHelp(): string {
  return `usage: artifacts <command> [<args>]

Manage Cloudflare Artifacts repositories and git tokens. Every
repository name you pass is implicitly scoped to this session: the
name 'starter' addresses the repo stored as '<session>__starter'.
You only ever work in local names; the session prefix is added on
the way in and stripped on the way out. 'repo list' shows only this
session's repositories.

Commands:
   repo    Manage repositories (create, get, list, delete, import).
   token   Manage git tokens for a repository.
   help    Show this help.

Run 'artifacts repo --help' or 'artifacts token --help' for the
subcommands in each group.

Output: reads and creates print JSON on stdout; delete and revoke
print a one-line confirmation. Exit codes: 0 success, 1 the
operation failed, 129 a malformed command line.

Secrets: 'token create' is the only command that prints a token's
plaintext. 'token list' and 'token get' show metadata only.
`;
}

function repoHelp(): string {
  return `usage: artifacts repo <subcommand> [<args>]

All names are session-scoped; pass local names only.

   repo create <name> [--description <text>] [--default-branch <branch>] [--read-only]
       Create a repository. Prints JSON: { name, remote, defaultBranch, token }.
       The token is an initial git token — treat it as a secret.

   repo get <name>
       Print JSON metadata for a repository: ArtifactsRepoInfo with a local name.

   repo list
       Print a JSON array of this session's repository metadata (without remote).

   repo delete <name>
       Delete a repository. Prints a one-line confirmation.

   repo import <name> --url <https-url> [--branch <branch>] [--depth <n>] [--read-only] [--description <text>]
       Import an external git remote into a new repository.

Example:
   artifacts repo create build-cache --description "CI artifacts"
   artifacts repo list
`;
}

function tokenHelp(): string {
  return `usage: artifacts token <subcommand> [<args>]

Tokens authenticate git operations against a repository's remote.
The <repo> argument is a session-scoped local name.

   token create <repo> [--scope read|write] [--ttl <seconds>]
       Mint a token. Prints JSON: { id, plaintext, scope, expiresAt }.
       The plaintext is shown ONCE here and nowhere else — capture it.
       --scope defaults to write. --ttl defaults to the service default.

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
