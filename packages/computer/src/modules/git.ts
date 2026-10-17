// `ws:git`: the Workspace's Git client for isolate JavaScript.
//
//   import { status, diff, log, clone, cli } from "ws:git";
//
// Every path the isolate passes is confined to the JavaScript backend's
// root. Commands that change the repository need a read-write backend,
// and commands that reach the network are denied unless the module is
// created with `allowNetwork: true`: they run from the host, so the
// isolate's own egress settings do not stop them.

import type { GitClient } from "../git/index.js";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceModuleTypes,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

const NETWORK_COMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);

/** Options for {@link createGitModule}. */
export interface GitModuleOptions {
  /**
   * Allow `clone` and network `cli` commands such as `fetch` and `push`.
   * Defaults to `false`. These requests run from the host, so the
   * JavaScript backend's egress settings do not apply to them.
   */
  readonly allowNetwork?: boolean;
}

/**
 * Build the `ws:git` host module over the Workspace's Git client.
 *
 * It exports `clone`, `diff`, `status`, `log`, and `cli`. Each takes the
 * same options object as the matching `GitClient` method, with `dir` or
 * `cwd` resolved against the backend root. A call that passes anything
 * other than one options object is refused with the expected shape, so
 * code that guessed the signature learns it from the error.
 *
 * @param options - Whether network commands are allowed.
 * @returns The module to pass as `modules["ws:git"]`.
 */
export function createGitModule(options: GitModuleOptions = {}): WorkspaceModuleFactory {
  const allowNetwork = options.allowNetwork ?? false;
  const requireNetwork = (operation: string) => {
    if (!allowNetwork) {
      throw new Error(`${operation} requires createGitModule({ allowNetwork: true }).`);
    }
  };

  const create = (host: WorkspaceModuleHost): WorkspaceModuleFunctions => ({
    async clone(args, context) {
      requireWrite(context, "Git clone");
      const input = optionsObject("clone", args, { required: true });
      if (typeof input.url !== "string" || input.url === "") {
        throw new TypeError(`ws:git clone needs a url. ${USAGE.clone}`);
      }
      requireNetwork("Git clone");
      // SAFETY: The isolate's options object passes through to the Git client, as it did when ws:git was built in. The client checks its own options; only the path is rewritten here.
      return host.git.clone(
        (await withDir(input, context, true)) as unknown as Parameters<GitClient["clone"]>[0],
      );
    },
    async diff(args, context) {
      const input = optionsObject("diff", args);
      // SAFETY: As for clone.
      return host.git.diff((await withDir(input, context)) as Parameters<GitClient["diff"]>[0]);
    },
    async status(args, context) {
      const input = optionsObject("status", args);
      // SAFETY: As for clone.
      return host.git.status((await withDir(input, context)) as Parameters<GitClient["status"]>[0]);
    },
    async log(args, context) {
      const input = optionsObject("log", args);
      // SAFETY: As for clone.
      return host.git.log((await withDir(input, context)) as Parameters<GitClient["log"]>[0]);
    },
    async cli(args, context) {
      requireWrite(context, "Git CLI");
      const input = optionsObject("cli", args, { required: true });
      const argv = cliArguments(input.argv);
      const directory = input.cwd ?? ".";
      if (typeof directory !== "string") {
        throw new TypeError(`ws:git cli cwd must be a string. ${USAGE.cli}`);
      }
      const leading = leadingDirectory(argv, directory);
      assertSafeCliArguments(leading.argv);
      if (leading.argv.some((argument) => NETWORK_COMMANDS.has(argument.toLowerCase()))) {
        requireNetwork("Git CLI network command");
      }
      // SAFETY: As for clone. argv and cwd were checked above.
      const rest = input as unknown as Omit<Parameters<GitClient["cli"]>[0], "argv" | "cwd">;
      return host.git.cli({
        ...rest,
        argv: leading.argv,
        cwd: await context.resolvePath(leading.cwd, { allowMissing: true }),
      });
    },
  });
  return Object.assign(create, {
    description: `The workspace's Git repository: \`status({ dir })\`, \`diff({ dir, ref })\`, \`log({ dir, depth })\`, \`clone({ url, dir })\`, and \`cli({ argv, cwd })\` for any other git subcommand. \`argv\` leaves out "git": \`cli({ argv: ["commit", "-m", "Fix"] })\`.${allowNetwork ? "" : " Network commands such as clone, fetch, and push are not allowed."}`,
    types: gitTypes(allowNetwork),
    examples: [
      'const { stdout } = await cli({ argv: ["log", "--oneline", "-5"] });',
      'await cli({ argv: ["add", "."] });',
      'await cli({ argv: ["commit", "-m", "Update notes"] });',
      "const changed = await status();",
    ],
  });
}

// How each export is called, for errors from a call that guessed.
const USAGE = {
  clone: 'Call it as clone({ url: "https://github.com/owner/repo", dir?: "repo" }).',
  diff: 'Call it as diff({ dir?: "repo", ref?: "HEAD", to?: "main", paths?: ["src"] }).',
  status: 'Call it as status({ dir?: "repo" }).',
  log: 'Call it as log({ dir?: "repo", ref?: "HEAD", depth?: 10 }).',
  cli: 'Call it as cli({ argv: ["status"], cwd?: "repo" }), where argv leaves out "git".',
} as const;

function gitTypes(allowNetwork: boolean): WorkspaceModuleTypes {
  const network = allowNetwork
    ? ""
    : "\n * Network subcommands (clone, fetch, pull, push, ls-remote, submodule) are not allowed here.";
  return {
    GitCliResult: `interface GitCliResult {
  stdout: string;
  stderr: string;
  /** 0 on success. A failing command resolves with a non-zero code; it does not reject. */
  exitCode: number;
}`,
    StatusEntry: `/**
 * One changed path. \`index\` is the staged change against HEAD and
 * \`worktree\` the unstaged one: " " unchanged, "A" added, "M" modified,
 * "D" deleted, "?" untracked.
 */
interface StatusEntry {
  path: string;
  index: " " | "A" | "M" | "D";
  worktree: " " | "A" | "M" | "D" | "?";
}`,
    GitPerson: `interface GitPerson {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  timestamp: number;
  /** Minutes east of UTC. */
  timezoneOffset: number;
}`,
    CommitView: `interface CommitView {
  oid: string;
  message: string;
  tree: string;
  parent: string[];
  author: GitPerson;
  committer: GitPerson;
}`,
    clone: `/**
 * Clone an HTTPS repository into \`dir\`, which defaults to the backend root.
 * \`depth\` makes a shallow clone; \`headers\` can carry an Authorization header.${
   allowNetwork ? "" : "\n * Not allowed here: cloning needs network access."
 }
 */
function clone(options: {
  url: string;
  dir?: string;
  ref?: string;
  depth?: number;
  singleBranch?: boolean;
  noTags?: boolean;
  paths?: string[];
  headers?: Record<string, string>;
}): Promise<null>;`,
    diff: `/**
 * A unified diff. Without \`to\`, between \`ref\` (default HEAD) and the
 * working tree. With \`to\`, between the two commits.
 */
function diff(options?: { dir?: string; ref?: string; to?: string; paths?: string[] }): Promise<string>;`,
    status: `/** The changed paths of the repository at \`dir\`, which defaults to the backend root. */
function status(options?: { dir?: string }): Promise<StatusEntry[]>;`,
    log: `/** Commits from \`ref\` (default HEAD) backwards, newest first, at most \`depth\` of them. */
function log(options?: { dir?: string; ref?: string; depth?: number }): Promise<CommitView[]>;`,
    cli: `/**
 * Run a git subcommand, as the git command line would. \`argv\` leaves
 * out "git": \`["log", "--oneline", "-5"]\`. \`cwd\` defaults to the backend
 * root, and a leading \`["-C", path]\` works too.${network}
 */
function cli(input: { argv: string[]; cwd?: string; env?: Record<string, string> }): Promise<GitCliResult>;`,
  };
}

// Every export takes one options object. A string or an array in its
// place is the usual guess, and passing it on would run the command
// with no arguments, so refuse it and show the shape instead.
function optionsObject(
  operation: keyof typeof USAGE,
  args: readonly WorkspaceRuntimeValue[],
  options: { readonly required?: boolean } = {},
): Record<string, WorkspaceRuntimeValue> {
  const [value, ...rest] = args;
  if (value === undefined && options.required !== true) return {};
  if (
    rest.length > 0 ||
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    const got = args.map((arg) => JSON.stringify(arg) ?? "undefined").join(", ");
    throw new TypeError(
      `ws:git ${operation} takes one options object, but got (${got}). ${USAGE[operation]}${SEE_DOCS}`,
    );
  }
  // An option the export does not take would be ignored, and a guess
  // such as log({ cwd }) would then run somewhere else. Name the ones
  // it does take.
  const allowed = OPTION_KEYS[operation];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `ws:git ${operation} has no option ${unknown.map((key) => JSON.stringify(key)).join(" or ")}. Its options are ${allowed.join(", ")}.${SEE_DOCS}`,
    );
  }
  return value;
}

const SEE_DOCS = ' docs("ws:git") from cf:computer shows every export\'s declaration.';

// The options each export takes, as its declaration lists them.
const OPTION_KEYS: Readonly<Record<keyof typeof USAGE, readonly string[]>> = {
  clone: ["url", "dir", "ref", "depth", "singleBranch", "noTags", "paths", "headers"],
  diff: ["dir", "ref", "to", "paths"],
  status: ["dir"],
  log: ["dir", "ref", "depth"],
  cli: ["argv", "cwd", "env"],
};

function cliArguments(value: WorkspaceRuntimeValue | undefined): string[] {
  if (!Array.isArray(value) || !value.every(isString)) {
    throw new TypeError(`ws:git cli argv must be an array of strings. ${USAGE.cli}${SEE_DOCS}`);
  }
  if (value[0] === "git") {
    throw new TypeError(
      `ws:git cli argv leaves out "git": pass ${JSON.stringify(value.slice(1))}, not ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function isString(value: WorkspaceRuntimeValue): value is string {
  return typeof value === "string";
}

function requireWrite(context: WorkspaceModuleCallContext, operation: string) {
  if (context.access !== "read-write") {
    throw new Error(`${operation} requires Workspace write access.`);
  }
}

async function withDir(
  options: Record<string, WorkspaceRuntimeValue>,
  context: WorkspaceModuleCallContext,
  allowMissing = false,
): Promise<Record<string, WorkspaceRuntimeValue>> {
  return {
    ...options,
    dir: await context.resolvePath(typeof options.dir === "string" ? options.dir : ".", {
      allowMissing,
    }),
  };
}

// Agents often run `git -C <path> <subcommand>`. A leading `-C` becomes
// the working directory, so it goes through the same confinement as
// `cwd` instead of reaching the Git client as a path override.
function leadingDirectory(argv: string[], cwd: string): { argv: string[]; cwd: string } {
  if (argv[0] !== "-C") return { argv, cwd };
  const directory = argv[1];
  if (directory === undefined || directory === "") {
    throw new Error("Git CLI option '-C' requires a value.");
  }
  return {
    argv: argv.slice(2),
    cwd: directory.startsWith("/") ? directory : `${cwd.replace(/\/+$/, "")}/${directory}`,
  };
}

// Any other path override would let a command escape the confined
// directory.
function assertSafeCliArguments(argv: readonly string[]) {
  if (
    argv.some(
      (argument) =>
        argument === "-C" ||
        argument.startsWith("-C") ||
        argument === "--git-dir" ||
        argument.startsWith("--git-dir=") ||
        argument === "--work-tree" ||
        argument.startsWith("--work-tree="),
    )
  ) {
    throw new Error(
      "Git CLI path overrides are not available inside a confined Workspace runtime.",
    );
  }
}
