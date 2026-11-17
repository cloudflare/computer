// The `git`, `assets` and `artifacts` shell commands, for every shell
// that offers them. Each shell adapts its own command signature to these
// functions, so all print the same output and messages for the same
// argv.

import type { ArtifactsCLIInput, ArtifactsCLIResult, RemoteAddFn } from "../artifacts/index";
import type { GitCliInput, GitCliResult } from "../git/index";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs `git` through the Workspace's git client. `args` excludes the
 * command name. The client turns its own subcommand failures into
 * results; a throw (no git configured, transport failure) becomes
 * exit 1 with the message on stderr.
 */
export async function runGitCommand(
  git: { cli(input: GitCliInput): Promise<GitCliResult> },
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
): Promise<CommandResult> {
  try {
    const result = await git.cli({
      argv: args,
      cwd,
      env,
      ...(stdin === undefined ? {} : { stdin }),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stdout: "", stderr: `git: ${message}\n`, exitCode: 1 };
  }
}

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;
const ASSETS_USAGE = "usage: assets publish <path> [<expiry>]\n";

/**
 * Runs `assets publish <path> [<expiry>]`. `args` excludes the command
 * name. `publish` is undefined when the Workspace has no assets client.
 */
export async function runAssetsCommand(
  args: readonly string[],
  cwd: string,
  publish: ((path: string, options: { expiresAfter: number }) => Promise<string>) | undefined,
): Promise<CommandResult> {
  if (args[0] !== "publish" || args.length < 2 || args.length > 3) {
    return { stdout: "", stderr: ASSETS_USAGE, exitCode: 2 };
  }
  if (publish === undefined) {
    return {
      stdout: "",
      stderr: "assets: publishing is not configured for this workspace\n",
      exitCode: 1,
    };
  }

  const path = resolvePath(cwd, args[1]);
  const expiresAfter = args[2] === undefined ? DEFAULT_EXPIRY_MS : parseExpiry(args[2]);
  if (expiresAfter === undefined) {
    return {
      stdout: "",
      stderr: `assets: invalid expiry ${JSON.stringify(args[2])}\n`,
      exitCode: 2,
    };
  }

  try {
    const url = await publish(path, { expiresAfter });
    return { stdout: `${url}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stdout: "", stderr: `assets: ${message}\n`, exitCode: 1 };
  }
}

export interface ArtifactsCommandClients {
  artifacts: { cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> };
  git: { cli(input: GitCliInput): Promise<GitCliResult> };
}

/**
 * Runs `artifacts ...` through the host artifacts client. `args`
 * excludes the command name. The artifacts package has no git of its
 * own, so the `create` shorthand's remote is added through `git.cli`
 * at `cwd`, where the caller's repository is.
 */
export async function runArtifactsCommand(
  clients: ArtifactsCommandClients,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  // Collisions are detected by listing first, so the artifacts CLI can
  // tell "name taken" (recoverable with --force) apart from any other
  // git failure.
  const remoteAdd: RemoteAddFn = async ({ name, url, force }) => {
    if (force !== true) {
      const listed = await clients.git.cli({ argv: ["remote"], cwd, env });
      const names = listed.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.includes(name)) return { ok: false, exists: true };
    }
    const addArgs =
      force === true ? ["remote", "add", "--force", name, url] : ["remote", "add", name, url];
    const result = await clients.git.cli({ argv: addArgs, cwd, env });
    if (result.exitCode !== 0) {
      return { ok: false, message: (result.stderr || result.stdout).trim() };
    }
    return { ok: true };
  };

  try {
    const result = await clients.artifacts.cli({ argv: args, env, remoteAdd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (cause) {
    // The CLI dispatcher returns its own subcommand failures as
    // { exitCode } results. A throw here means the host call itself
    // failed, so surface it as an ordinary command failure.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { stdout: "", stderr: `artifacts: ${message}\n`, exitCode: 1 };
  }
}

function parseExpiry(input: string): number | undefined {
  const match = input.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const result = value * multiplier;
  return result > 0 && Number.isSafeInteger(result) ? result : undefined;
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return normalizeAbsolute(path);
  return normalizeAbsolute(`${cwd}/${path}`);
}

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
