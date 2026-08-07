// Argv-driven git surface.
//
// `runGitCli` is the single dispatcher behind `GitClient.cli` and
// behind the worker-backend's `git` custom command in the shell
// isolate. Each subcommand has its own flag-table-driven parser
// and delegates to the same `GitClient` methods the typed surface
// uses — `cloneWith` / `diffWith` / `commitWith` / and friends —
// so the JS API and the CLI surface cannot drift in behaviour.
//
// Unknown subcommands exit 1 with a stderr line shaped like real
// git's "'<cmd>' is not a git command" so callers can match on
// it. Argv-shape errors (unknown options, missing required
// values) exit 129. See `docs/13_git_interface.md` for the full
// list of supported subcommands and their flag mappings.

import {
  AlreadyInitializedError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";
import type { CommitView, DiffSummaryEntry, GitClient, GitIdentity, StatusEntry } from "./index.js";
import { formatPorcelainV1, formatPorcelainV2, formatShort } from "./status.js";

export interface GitCliInput {
  /** Argv as seen by the shell command. `argv[0]` is the subcommand. */
  argv: string[];
  /**
   * Working directory inside the workspace VFS. Subcommands that
   * accept a `dir` flag default to this when the flag is absent.
   * Defaults to `/` if omitted.
   */
  cwd?: string;
  /** Environment variables. Identity defaulting reads from here. */
  env?: Record<string, string>;
  /** Stdin, decoded to UTF-8. Currently unused; reserved for `commit -F -`. */
  stdin?: string;
}

export interface GitCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitCliOptions {
  /**
   * Default identity passed through to commit-producing
   * subcommands when the caller's env doesn't carry
   * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`. The CLI itself does not
   * read this; `runCommit`, `runPull`, and `runMerge` all hand
   * the value to the underlying `GitClient` method through
   * `input.env` and the client resolves the precedence.
   */
  defaultIdentity?: GitIdentity;
}

export async function runGitCli(
  client: GitClient,
  input: GitCliInput,
  _options: RunGitCliOptions = {},
): Promise<GitCliResult> {
  // Strip leading global options (currently only `-C <path>`)
  // before the subcommand. Real git accepts these between `git`
  // and the subcommand; agents lean on `-C` to avoid changing
  // process cwd. The path rewrites the effective cwd that each
  // subcommand's `dir` default resolves against.
  const global = parseGlobalOptions(input.argv, input.cwd);
  if ("error" in global) {
    return { stdout: "", stderr: `git: ${global.error}\n`, exitCode: 129 };
  }
  const argv = global.argv;
  if (argv.length === 0) {
    return printHelp();
  }
  input = global.cwd === input.cwd ? input : { ...input, cwd: global.cwd };
  const [sub, ...rest] = argv;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    case "version":
    case "--version":
      return printVersion();
    case "clone":
      return await runClone(client, rest, input);
    case "diff":
      return await runDiff(client, rest, input);
    case "init":
      return await runInit(client, rest, input);
    case "status":
      return await runStatus(client, rest, input);
    case "add":
      return await runAdd(client, rest, input);
    case "rm":
      return await runRm(client, rest, input);
    case "commit":
      return await runCommit(client, rest, input);
    case "log":
      return await runLog(client, rest, input);
    case "show":
      return await runShow(client, rest, input);
    case "rev-parse":
      return await runRevParse(client, rest, input);
    case "symbolic-ref":
      return await runSymbolicRef(client, rest, input);
    case "ls-files":
      return await runLsFiles(client, rest, input);
    case "ls-tree":
      return await runLsTree(client, rest, input);
    case "branch":
      return await runBranch(client, rest, input);
    case "tag":
      return await runTag(client, rest, input);
    case "checkout":
      return await runCheckout(client, rest, input);
    case "switch":
      return await runSwitch(client, rest, input);
    case "fetch":
      return await runFetch(client, rest, input);
    case "push":
      return await runPush(client, rest, input);
    case "pull":
      return await runPull(client, rest, input);
    case "merge":
      return await runMerge(client, rest, input);
    case "remote":
      return await runRemote(client, rest, input);
    case "hash-object":
      return await runHashObject(client, rest, input);
    case "cat-file":
      return await runCatFile(client, rest, input);
    case "update-ref":
      return await runUpdateRef(client, rest, input);
    case "config":
      return await runConfig(client, rest, input);
    case "stash":
      return await runStash(client, rest, input);
    case "reset":
      return await runReset(client, rest, input);
    case "clean":
      return await runClean(client, rest, input);
    default:
      return {
        stdout: "",
        stderr: `git: '${sub}' is not a supported workspace git command\n`,
        exitCode: 1,
      };
  }
}

// ---------------------------------------------------------------
// help / version
// ---------------------------------------------------------------

function printHelp(): GitCliResult {
  const lines = [
    "usage: git <command> [<args>]",
    "",
    "Supported workspace git commands:",
    "   add           Stage paths into the index.",
    "   branch        Create, delete, or list branches.",
    "   cat-file      Read raw bytes for an object by oid.",
    "   checkout      Move HEAD to a ref, or restore paths.",
    "   clean         Remove untracked files from the working tree.",
    "   clone         Clone a remote repository into the workspace.",
    "   commit        Write the current index to a new commit.",
    "   config        Read or write a config key.",
    "   diff          Show changes between HEAD and the working tree.",
    "   fetch         Fetch refs from a remote.",
    "   hash-object   Hash bytes as a blob (optionally write).",
    "   init          Initialise a new repository.",
    "   log           List commits reachable from HEAD.",
    "   ls-files      List files in the index (or at a ref).",
    "   ls-tree       List one level of a tree.",
    "   merge         Merge a ref into the current branch.",
    "   pull          Fetch and merge in one step.",
    "   push          Push local refs to a remote.",
    "   remote        Manage configured remotes.",
    "   reset         Unstage paths or hard-reset to a ref.",
    "   rev-parse     Resolve a ref to its SHA-1 oid.",
    "   rm            Unstage paths from the index.",
    "   show          Read a single commit.",
    "   stash         Stash and restore working-tree changes.",
    "   status        Describe the working-tree / index / HEAD delta.",
    "   switch        Switch branches, or create one with -c.",
    "   symbolic-ref  Print the current branch name.",
    "   tag           Create, delete, or list tags.",
    "   update-ref    Write a ref directly.",
    "   help          Show this help.",
    "   version       Print the workspace git wrapper version.",
    "",
  ];
  return { stdout: `${lines.join("\n")}`, stderr: "", exitCode: 0 };
}

function printVersion(): GitCliResult {
  // Deliberately not impersonating a real git version string.
  // Consumers that fingerprint via `git --version` will see this
  // and can branch on it.
  return {
    stdout: "git version 0.0.0 (@cloudflare/computer)\n",
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------
// clone
// ---------------------------------------------------------------

async function runClone(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git clone [--depth N] [--branch B] [--single-branch | --no-single-branch]
  //            [--no-tags] [--bare? rejected] <url> [<dir>]`
  const parsed = parseFlags(args, {
    depth: { kind: "value" },
    branch: { kind: "value", alias: ["b"] },
    "single-branch": { kind: "bool" },
    "no-single-branch": { kind: "bool" },
    "no-tags": { kind: "bool" },
    tags: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git clone: ${parsed.error}\n`, exitCode: 129 };
  }
  const positional = parsed.positional;
  if (positional.length === 0) {
    return { stdout: "", stderr: "git clone: missing <repository>\n", exitCode: 129 };
  }
  if (positional.length > 2) {
    return {
      stdout: "",
      stderr: `git clone: unexpected argument '${positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [url, dirArg] = positional;
  if (!isSupportedRemoteUrl(url)) {
    return {
      stdout: "",
      stderr: `git clone: unsupported transport for '${url}'. Only https://, http://, and file:// are supported.\n`,
      exitCode: 1,
    };
  }
  let dir: string;
  if (dirArg !== undefined && dirArg !== "") {
    dir = resolveDir(dirArg, input.cwd);
  } else {
    // Real git derives the destination from the last path segment
    // of the URL when no positional <dir> is given, so `git clone
    // https://host/owner/repo.git` lands in `./repo` rather than
    // splattering the working tree into cwd.
    const name = repoNameFromUrl(url);
    if (name === undefined) {
      return {
        stdout: "",
        stderr: `git clone: could not derive a directory name from '${url}'. Pass an explicit destination.\n`,
        exitCode: 129,
      };
    }
    dir = resolveDir(name, input.cwd);
  }

  let depth: number | undefined;
  if (parsed.flags.depth !== undefined) {
    const n = Number.parseInt(parsed.flags.depth as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      return {
        stdout: "",
        stderr: `git clone: --depth requires a non-negative integer (got ${JSON.stringify(parsed.flags.depth)})\n`,
        exitCode: 129,
      };
    }
    depth = n;
  }

  let singleBranch: boolean | undefined;
  if (parsed.flags["single-branch"]) singleBranch = true;
  if (parsed.flags["no-single-branch"]) singleBranch = false;

  let noTags: boolean | undefined;
  if (parsed.flags["no-tags"]) noTags = true;
  if (parsed.flags.tags) noTags = false;

  try {
    await client.clone({
      url,
      dir,
      ref: parsed.flags.branch as string | undefined,
      depth,
      singleBranch,
      noTags,
    });
  } catch (cause) {
    return {
      stdout: "",
      stderr: `git clone: ${errorMessage(cause)}\n`,
      exitCode: 1,
    };
  }
  return {
    stdout: `Cloning into '${dir}'...\n`,
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------
// diff
// ---------------------------------------------------------------

async function runDiff(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git diff [--stat|--name-only|--name-status] [<ref> | <from>
  // <to>] [-- <path>...]`. Two refs before `--` switch to
  // ref-to-ref mode; paths after `--` filter the output. The
  // summary flags swap the unified patch for a per-file summary.
  const parsed = parseFlags(args, {
    stat: { kind: "bool" },
    "name-only": { kind: "bool" },
    "name-status": { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git diff: ${parsed.error}\n`, exitCode: 129 };
  }
  const wantStat = parsed.flags.stat === true;
  const wantNameOnly = parsed.flags["name-only"] === true;
  const wantNameStatus = parsed.flags["name-status"] === true;
  // Split positional on '--' — anything after is a path filter.
  // The parser already consumes '--' and treats the rest as
  // positional, so we need to remember where it was. Rebuild
  // from raw argv.
  const sep = args.indexOf("--");
  const refArgs =
    sep === -1 ? parsed.positional : args.slice(0, sep).filter((a) => !a.startsWith("-"));
  const pathArgs = sep === -1 ? [] : args.slice(sep + 1);

  if (refArgs.length > 2) {
    return {
      stdout: "",
      stderr: `git diff: too many refs (expected at most 2, got ${refArgs.length})\n`,
      exitCode: 129,
    };
  }
  const [from, to] = refArgs;
  const dir = resolveDir(undefined, input.cwd);
  try {
    const fromResolved = await resolveRevisionRef(client, dir, from);
    const toResolved = await resolveRevisionRef(client, dir, to);
    const paths = pathArgs.length > 0 ? pathArgs : undefined;

    if (wantStat || wantNameOnly || wantNameStatus) {
      const summary = await client.diffSummary({
        dir,
        ref: fromResolved,
        to: toResolved,
        paths,
      });
      const stdout = wantNameOnly
        ? formatDiffNameOnly(summary)
        : wantNameStatus
          ? formatDiffNameStatus(summary)
          : formatDiffStat(summary);
      return { stdout, stderr: "", exitCode: 0 };
    }

    const output = await client.diff({
      dir,
      ref: fromResolved,
      to: toResolved,
      paths,
    });
    return { stdout: output, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("diff", cause);
  }
}

type DiffSummary = DiffSummaryEntry;

/** `--name-only`: one changed path per line. */
function formatDiffNameOnly(entries: DiffSummary[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((e) => e.path).join("\n")}\n`;
}

/** `--name-status`: `<status>\t<path>` per line. */
function formatDiffNameStatus(entries: DiffSummary[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((e) => `${e.status}\t${e.path}`).join("\n")}\n`;
}

/**
 * `--stat`: a per-file line with a `+`/`-` bar plus a summary
 * footer. The graph is scaled-down only when the widest file's
 * total exceeds the column budget, mirroring real git closely
 * enough for a human to read and a script to grep the footer.
 */
function formatDiffStat(entries: DiffSummary[]): string {
  if (entries.length === 0) return "";
  const nameWidth = Math.max(...entries.map((e) => e.path.length));
  const maxTotal = Math.max(...entries.map((e) => e.insertions + e.deletions));
  // Cap the bar at 60 columns the way git's default terminal
  // width does; scale proportionally when any file exceeds it.
  const budget = 60;
  const scale = maxTotal > budget ? budget / maxTotal : 1;

  const lines: string[] = [];
  let totalIns = 0;
  let totalDel = 0;
  for (const e of entries) {
    totalIns += e.insertions;
    totalDel += e.deletions;
    const total = e.insertions + e.deletions;
    const plus = Math.round(e.insertions * scale);
    const minus = Math.round(e.deletions * scale);
    const bar = `${"+".repeat(plus)}${"-".repeat(minus)}`;
    lines.push(` ${e.path.padEnd(nameWidth)} | ${String(total).padStart(4)} ${bar}`);
  }

  const fileWord = entries.length === 1 ? "file" : "files";
  const parts = [`${entries.length} ${fileWord} changed`];
  if (totalIns > 0) {
    parts.push(`${totalIns} ${totalIns === 1 ? "insertion(+)" : "insertions(+)"}`);
  }
  if (totalDel > 0) {
    parts.push(`${totalDel} ${totalDel === 1 ? "deletion(-)" : "deletions(-)"}`);
  }
  lines.push(` ${parts.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------
// init
// ---------------------------------------------------------------

async function runInit(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git init [--initial-branch=<name>] [--bare] [<dir>]`
  const parsed = parseFlags(args, {
    "initial-branch": { kind: "value", alias: ["b"] },
    bare: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git init: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git init: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(parsed.positional[0], input.cwd);
  try {
    await client.init({
      dir,
      defaultBranch: parsed.flags["initial-branch"] as string | undefined,
      bare: parsed.flags.bare === true,
    });
  } catch (cause) {
    return mapGitError("init", cause);
  }
  return {
    stdout: `Initialized empty Git repository in ${dir}/.git/\n`,
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------
// status
// ---------------------------------------------------------------

async function runStatus(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git status [--porcelain[=v2]] [--short | -s]`
  const parsed = parseFlags(args, {
    porcelain: { kind: "value-or-bool" },
    short: { kind: "bool", alias: ["s"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git status: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 0) {
    return {
      stdout: "",
      stderr: `git status: unexpected argument '${parsed.positional[0]}'\n`,
      exitCode: 129,
    };
  }
  // Format selection. The bare default is porcelain v2 — the
  // typed CLI surface is intentionally machine-readable and the
  // long-form human output is deferred. `--porcelain=v1` (and the
  // `1` spelling git also accepts) selects the v1 `XY <path>`
  // shape that the bulk of tooling parses.
  const porcelain = parsed.flags.porcelain;
  const useShort = parsed.flags.short === true;
  const isV1 = porcelain === "v1" || porcelain === "1";
  const isV2 = porcelain === undefined || porcelain === true || porcelain === "v2";
  if (porcelain !== undefined && porcelain !== true && !isV1 && !isV2) {
    return {
      stdout: "",
      stderr: `git status: unsupported --porcelain value '${porcelain}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  let entries: StatusEntry[];
  try {
    entries = await client.status({ dir });
  } catch (cause) {
    return mapGitError("status", cause);
  }
  const stdout = useShort
    ? formatShort(entries)
    : isV1
      ? formatPorcelainV1(entries)
      : formatPorcelainV2(entries);
  return { stdout, stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------
// add
// ---------------------------------------------------------------

async function runAdd(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git add [-A|--all] [--force] <pathspec>...`
  const parsed = parseFlags(args, {
    force: { kind: "bool", alias: ["f"] },
    all: { kind: "bool", alias: ["A"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git add: ${parsed.error}\n`, exitCode: 129 };
  }
  const all = parsed.flags.all === true;
  // `-A` stages the whole tree and needs no pathspec; without it a
  // missing pathspec is the same no-op error real git prints.
  if (!all && parsed.positional.length === 0) {
    return { stdout: "", stderr: "git add: nothing specified, nothing added.\n", exitCode: 129 };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    await client.add({
      dir,
      paths: all ? [] : parsed.positional,
      all,
      force: parsed.flags.force === true,
    });
  } catch (cause) {
    return mapGitError("add", cause);
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------
// rm
// ---------------------------------------------------------------

async function runRm(client: GitClient, args: string[], input: GitCliInput): Promise<GitCliResult> {
  // `git rm <pathspec>...`. We don't surface --cached (yet); the
  // typed surface lacks it and isomorphic-git's `remove` only
  // unstages — it does not touch the working tree. Document this
  // in the docs phase; warn here so a caller piping in --cached
  // isn't surprised.
  const parsed = parseFlags(args, {
    cached: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git rm: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length === 0) {
    return {
      stdout: "",
      stderr: "git rm: no pathspec given on command line\n",
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    await client.rm({ dir, paths: parsed.positional });
  } catch (cause) {
    return mapGitError("rm", cause);
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------
// commit
// ---------------------------------------------------------------

async function runCommit(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git commit [-a] -m <msg> [--amend] [--author="Name <email>"]`
  //
  // Expand a combined short cluster like `-am` into `-a -m`
  // first; the generic parser treats `-am` as one unknown short
  // option. Only the `-a`/`-m` combination matters here.
  const expanded = expandCommitShortCluster(args);
  const parsed = parseFlags(expanded, {
    message: { kind: "value", alias: ["m"] },
    amend: { kind: "bool" },
    author: { kind: "value" },
    all: { kind: "bool", alias: ["a"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git commit: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 0) {
    return {
      stdout: "",
      stderr: `git commit: unexpected argument '${parsed.positional[0]}'\n`,
      exitCode: 129,
    };
  }
  const message = parsed.flags.message as string | undefined;
  if (!message) {
    return {
      stdout: "",
      stderr: "git commit: -m <message> is required\n",
      exitCode: 129,
    };
  }
  let author: { name: string; email: string } | undefined;
  if (parsed.flags.author !== undefined) {
    author = parseAuthorString(parsed.flags.author as string);
    if (!author) {
      return {
        stdout: "",
        stderr: `git commit: malformed --author '${parsed.flags.author}'. Expected 'Name <email>'.\n`,
        exitCode: 129,
      };
    }
  }
  const dir = resolveDir(undefined, input.cwd);
  // Identity resolution happens inside commitWith via the typed
  // surface; mirror the same env shape here.
  try {
    // `-a` stages tracked modifications and deletions (never
    // untracked files) before the commit, matching `git commit
    // -a`. A staging failure aborts before the commit runs.
    if (parsed.flags.all === true) {
      await client.add({ dir, paths: [], all: true, trackedOnly: true });
    }
    const { oid } = await client.commit({
      dir,
      message,
      author,
      amend: parsed.flags.amend === true,
      env: input.env,
    });
    // Real git prints a richer summary; the short form keeps
    // automation simple.
    return {
      stdout: `[${oid.slice(0, 7)}] ${firstLine(message)}\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (cause) {
    return mapGitError("commit", cause);
  }
}

/**
 * Expand the `-a`/`-m` short cluster (`-am`) into separate
 * tokens (`-a -m`). `-m` takes a value, so it must be last in the
 * cluster — only `-a…m` is expanded, leaving the message value to
 * follow as the next argv token. `-ma` is left untouched: real
 * git reads that as `-m` with the value `a`, and the generic
 * parser handles it.
 */
/**
 * Expand a cluster of single-char boolean short flags (`-fd` ->
 * `-f -d`) when every character is in `chars`. Clusters with a
 * character outside the set are left untouched for the generic
 * parser to handle or reject. Only safe for flags that take no
 * value.
 */
function expandShortBoolCluster(args: string[], chars: Set<string>): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (/^-[a-z]{2,}$/i.test(arg) && [...arg.slice(1)].every((c) => chars.has(c))) {
      for (const ch of arg.slice(1)) out.push(`-${ch}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

function expandCommitShortCluster(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (/^-a+m$/.test(arg)) {
      for (const ch of arg.slice(1)) out.push(`-${ch}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

function parseAuthorString(s: string): { name: string; email: string } | undefined {
  // `Name <email@host>` — the same shape `git -c user.email=...`
  // and `--author` accept. Anything else is rejected; the CLI
  // shouldn't silently drop the email half.
  const m = /^(.+?)\s*<([^<>]+)>\s*$/.exec(s);
  if (!m) return undefined;
  return { name: m[1].trim(), email: m[2].trim() };
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

// ---------------------------------------------------------------
// log
// ---------------------------------------------------------------

async function runLog(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git log [-n <N>] [-<N>] [--oneline] [<ref>]`. Default output
  // is the full commit form; --oneline collapses each entry to a
  // single line.
  //
  // Rewrite the `-<N>` shorthand (e.g. `-1`, `-5`) to `-n <N>`
  // before parsing — the generic parser would otherwise reject
  // `-5` as an unknown short option. `-0` and non-numeric forms
  // fall through to the `-n` validation below, which rejects
  // them.
  let shorthandDepth: string | undefined;
  const rewritten: string[] = [];
  for (const arg of args) {
    const m = /^-(\d+)$/.exec(arg);
    if (m) {
      shorthandDepth = m[1];
      continue;
    }
    rewritten.push(arg);
  }
  const parsed = parseFlags(rewritten, {
    n: { kind: "value" },
    oneline: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git log: ${parsed.error}\n`, exitCode: 129 };
  }
  if (shorthandDepth !== undefined && parsed.flags.n === undefined) {
    parsed.flags.n = shorthandDepth;
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git log: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  let depth: number | undefined;
  if (parsed.flags.n !== undefined) {
    const v = Number.parseInt(parsed.flags.n as string, 10);
    if (!Number.isFinite(v) || v < 1) {
      return {
        stdout: "",
        stderr: `git log: -n requires a positive integer (got ${JSON.stringify(parsed.flags.n)})\n`,
        exitCode: 129,
      };
    }
    depth = v;
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const ref = await resolveRevisionRef(client, dir, parsed.positional[0]);
    const commits = await client.log({ dir, ref, depth });
    const stdout = parsed.flags.oneline ? formatLogOneline(commits) : formatLogFull(commits);
    return { stdout, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("log", cause);
  }
}

function formatLogOneline(commits: CommitView[]): string {
  if (commits.length === 0) return "";
  return `${commits.map((c) => `${c.oid.slice(0, 7)} ${firstLine(c.message)}`).join("\n")}\n`;
}

function formatLogFull(commits: CommitView[]): string {
  if (commits.length === 0) return "";
  const blocks: string[] = [];
  for (const c of commits) {
    const lines = [
      `commit ${c.oid}`,
      `Author: ${c.author.name} <${c.author.email}>`,
      `Date:   ${formatGitTimestamp(c.author.timestamp, c.author.timezoneOffset)}`,
      "",
      ...c.message.split("\n").map((l) => `    ${l}`),
    ];
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

function formatGitTimestamp(timestamp: number, timezoneOffset: number): string {
  // isomorphic-git stores timezoneOffset using Date.getTimezoneOffset's
  // minutes-west-of-UTC convention. Git log renders the inverse offset
  // (`+0530` for timezoneOffset -330) and shifts the wall clock into
  // that zone before appending it.
  const offsetMinutes = -timezoneOffset;
  const d = new Date((timestamp + offsetMinutes * 60) * 1000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "")} ${sign}${hh}${mm}`;
}

// ---------------------------------------------------------------
// show
// ---------------------------------------------------------------

async function runShow(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) {
    return { stdout: "", stderr: `git show: ${parsed.error}\n`, exitCode: 129 };
  }
  const ref = parsed.positional[0] ?? "HEAD";
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git show: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const resolved = (await resolveRevisionRef(client, dir, ref)) ?? ref;
    const c = await client.show({ dir, ref: resolved });
    return { stdout: formatLogFull([c]), stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("show", cause);
  }
}

// ---------------------------------------------------------------
// rev-parse
// ---------------------------------------------------------------

async function runRevParse(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  const parsed = parseFlags(args, {
    "abbrev-ref": { kind: "bool" },
    "show-toplevel": { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git rev-parse: ${parsed.error}\n`, exitCode: 129 };
  }

  if (parsed.flags["show-toplevel"] === true) {
    // Print the working-tree root, walking up from cwd. Takes no
    // ref, so it short-circuits before the missing-ref check.
    const dir = resolveDir(undefined, input.cwd);
    try {
      const root = await client.repoRoot({ dir });
      return { stdout: `${root}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("rev-parse", cause);
    }
  }

  if (parsed.positional.length === 0) {
    return { stdout: "", stderr: "git rev-parse: missing <ref>\n", exitCode: 129 };
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git rev-parse: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  const ref = parsed.positional[0];

  if (parsed.flags["abbrev-ref"] === true) {
    // `--abbrev-ref HEAD` prints the symbolic branch name. On
    // detached HEAD real git falls back to printing the resolved
    // oid, so mirror that rather than erroring.
    try {
      if (ref === "HEAD") {
        const current = await client.currentBranch({ dir });
        if (current !== undefined) {
          return { stdout: `${current}\n`, stderr: "", exitCode: 0 };
        }
      }
      const oid = await client.revParse({ dir, ref });
      return { stdout: `${oid}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("rev-parse", cause);
    }
  }

  try {
    const oid = await client.revParse({ dir, ref });
    return { stdout: `${oid}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("rev-parse", cause);
  }
}

// ---------------------------------------------------------------
// symbolic-ref (current-branch)
// ---------------------------------------------------------------

async function runSymbolicRef(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // Limited surface: only `git symbolic-ref HEAD` and the bare
  // `git symbolic-ref` (which behaves like the previous form).
  const parsed = parseFlags(args, {
    short: { kind: "bool" },
    quiet: { kind: "bool", alias: ["q"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git symbolic-ref: ${parsed.error}\n`, exitCode: 129 };
  }
  const ref = parsed.positional[0] ?? "HEAD";
  if (ref !== "HEAD") {
    return {
      stdout: "",
      stderr: `git symbolic-ref: only HEAD is supported (got ${JSON.stringify(ref)})\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const name = await client.currentBranch({
      dir,
      fullname: parsed.flags.short !== true,
    });
    if (name === undefined) {
      // Detached HEAD: real git exits 1 with empty stdout when
      // --quiet, otherwise an error message.
      if (parsed.flags.quiet) return { stdout: "", stderr: "", exitCode: 1 };
      return {
        stdout: "",
        stderr: "git symbolic-ref: ref HEAD is not a symbolic ref\n",
        exitCode: 1,
      };
    }
    return { stdout: `${name}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("symbolic-ref", cause);
  }
}

// ---------------------------------------------------------------
// ls-files
// ---------------------------------------------------------------

async function runLsFiles(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  const parsed = parseFlags(args, {
    ref: { kind: "value" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git ls-files: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 0) {
    return {
      stdout: "",
      stderr: `git ls-files: unexpected argument '${parsed.positional[0]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const files = await client.lsFiles({ dir, ref: parsed.flags.ref as string | undefined });
    return { stdout: files.length === 0 ? "" : `${files.join("\n")}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("ls-files", cause);
  }
}

// ---------------------------------------------------------------
// ls-tree
// ---------------------------------------------------------------

async function runLsTree(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  const parsed = parseFlags(args, {});
  if ("error" in parsed) {
    return { stdout: "", stderr: `git ls-tree: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length === 0) {
    return { stdout: "", stderr: "git ls-tree: missing <tree-ish>\n", exitCode: 129 };
  }
  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git ls-tree: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [ref, subpath] = parsed.positional;
  const dir = resolveDir(undefined, input.cwd);
  try {
    const entries = await client.lsTree({ dir, ref, path: subpath });
    if (entries.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
    // Match real git's `git ls-tree` line format:
    //   <mode> SP <type> SP <oid> TAB <path>
    const lines = entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("ls-tree", cause);
  }
}

// ---------------------------------------------------------------
// branch
// ---------------------------------------------------------------

async function runBranch(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git branch` modes:
  //   bare           -> list local branches
  //   <name>         -> create branch at HEAD
  //   <name> <start> -> create branch at <start>
  //   -d <name>      -> delete branch
  //   --force        -> overwrite when creating
  const parsed = parseFlags(args, {
    d: { kind: "bool" },
    D: { kind: "bool" },
    delete: { kind: "bool" },
    force: { kind: "bool", alias: ["f"] },
    "show-current": { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git branch: ${parsed.error}\n`, exitCode: 129 };
  }
  const wantDelete =
    parsed.flags.d === true || parsed.flags.D === true || parsed.flags.delete === true;
  const dir = resolveDir(undefined, input.cwd);

  if (parsed.flags["show-current"] === true) {
    // Print the checked-out branch name, or nothing on detached
    // HEAD — matching real git's `branch --show-current`.
    try {
      const current = await client.currentBranch({ dir });
      return { stdout: current ? `${current}\n` : "", stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("branch", cause);
    }
  }

  if (wantDelete) {
    if (parsed.positional.length === 0) {
      return {
        stdout: "",
        stderr: "git branch: -d requires a branch name\n",
        exitCode: 129,
      };
    }
    try {
      for (const name of parsed.positional) {
        await client.branchDelete({ dir, name });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("branch", cause);
    }
  }

  if (parsed.positional.length === 0) {
    // List mode. Mark the current branch with a leading '* '
    // the way real git does so a consumer can grep for it.
    try {
      const [branches, current] = await Promise.all([
        client.branchList({ dir }),
        client.currentBranch({ dir }),
      ]);
      if (branches.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
      const lines = branches
        .slice()
        .sort()
        .map((b) => (b === current ? `* ${b}` : `  ${b}`));
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("branch", cause);
    }
  }

  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git branch: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [name, startPoint] = parsed.positional;
  try {
    await client.branch({
      dir,
      name,
      startPoint,
      force: parsed.flags.force === true,
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("branch", cause);
  }
}

// ---------------------------------------------------------------
// tag
// ---------------------------------------------------------------

async function runTag(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git tag` modes mirror branch: bare = list, <name> = create,
  // -d <name> = delete.
  const parsed = parseFlags(args, {
    d: { kind: "bool" },
    delete: { kind: "bool" },
    force: { kind: "bool", alias: ["f"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git tag: ${parsed.error}\n`, exitCode: 129 };
  }
  const wantDelete = parsed.flags.d === true || parsed.flags.delete === true;
  const dir = resolveDir(undefined, input.cwd);

  if (wantDelete) {
    if (parsed.positional.length === 0) {
      return {
        stdout: "",
        stderr: "git tag: -d requires a tag name\n",
        exitCode: 129,
      };
    }
    try {
      for (const name of parsed.positional) {
        await client.tagDelete({ dir, name });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("tag", cause);
    }
  }

  if (parsed.positional.length === 0) {
    try {
      const tags = await client.tagList({ dir });
      if (tags.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
      return {
        stdout: `${tags.slice().sort().join("\n")}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (cause) {
      return mapGitError("tag", cause);
    }
  }

  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git tag: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [name, object] = parsed.positional;
  try {
    await client.tag({ dir, name, object, force: parsed.flags.force === true });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("tag", cause);
  }
}

// ---------------------------------------------------------------
// checkout
// ---------------------------------------------------------------

async function runCheckout(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git checkout [-b <new>] <ref> [-- <paths>...]`. `-b` creates
  // a branch (optionally at a start point) and switches to it.
  const parsed = parseFlags(args, {
    force: { kind: "bool", alias: ["f"] },
    b: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git checkout: ${parsed.error}\n`, exitCode: 129 };
  }
  const sep = args.indexOf("--");
  const refArgs =
    sep === -1 ? parsed.positional : args.slice(0, sep).filter((a) => !a.startsWith("-"));
  const pathArgs = sep === -1 ? [] : args.slice(sep + 1);
  const dir = resolveDir(undefined, input.cwd);

  if (parsed.flags.b === true) {
    // Create-and-switch. `refArgs` is `<new-branch> [<start>]`.
    if (refArgs.length === 0) {
      return { stdout: "", stderr: "git checkout: -b requires a branch name\n", exitCode: 129 };
    }
    return createAndSwitch(client, dir, refArgs[0], refArgs[1], "checkout");
  }

  if (refArgs.length === 0) {
    return { stdout: "", stderr: "git checkout: missing <ref>\n", exitCode: 129 };
  }
  if (refArgs.length > 1) {
    return {
      stdout: "",
      stderr: `git checkout: unexpected argument '${refArgs[1]}'\n`,
      exitCode: 129,
    };
  }
  try {
    await client.checkout({
      dir,
      ref: refArgs[0],
      paths: pathArgs.length > 0 ? pathArgs : undefined,
      force: parsed.flags.force === true,
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("checkout", cause);
  }
}

// ---------------------------------------------------------------
// switch
// ---------------------------------------------------------------

async function runSwitch(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git switch [-c <new>] <branch> [<start>]`. The modern
  // spelling of `checkout` for branch movement; `-c` is the
  // `checkout -b` equivalent.
  const parsed = parseFlags(args, {
    c: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git switch: ${parsed.error}\n`, exitCode: 129 };
  }
  const dir = resolveDir(undefined, input.cwd);

  if (parsed.flags.c === true) {
    if (parsed.positional.length === 0) {
      return { stdout: "", stderr: "git switch: -c requires a branch name\n", exitCode: 129 };
    }
    return createAndSwitch(client, dir, parsed.positional[0], parsed.positional[1], "switch");
  }

  if (parsed.positional.length === 0) {
    return { stdout: "", stderr: "git switch: missing <branch>\n", exitCode: 129 };
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git switch: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  try {
    await client.checkout({ dir, ref: parsed.positional[0] });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("switch", cause);
  }
}

/**
 * Create a branch (optionally at a start point) and move HEAD to
 * it — the shared core of `checkout -b` and `switch -c`. The
 * branch is created first; only on success does HEAD move, so a
 * name collision leaves the working tree untouched.
 */
async function createAndSwitch(
  client: GitClient,
  dir: string,
  name: string,
  startPoint: string | undefined,
  subcommand: string,
): Promise<GitCliResult> {
  try {
    await client.branch({ dir, name, startPoint, force: false });
  } catch (cause) {
    return mapGitError(subcommand, cause);
  }
  try {
    await client.checkout({ dir, ref: name });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError(subcommand, cause);
  }
}

// ---------------------------------------------------------------
// fetch
// ---------------------------------------------------------------

async function runFetch(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git fetch [<remote>] [<ref>] [--depth N] [--no-tags] [--prune]`
  const parsed = parseFlags(args, {
    depth: { kind: "value" },
    "single-branch": { kind: "bool" },
    "no-single-branch": { kind: "bool" },
    tags: { kind: "bool" },
    "no-tags": { kind: "bool" },
    prune: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git fetch: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git fetch: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [first, second] = parsed.positional;
  // Heuristic mirroring real git: if the first positional looks
  // like a URL, treat it as the remote URL and the second as a
  // ref. Otherwise the first is a remote name.
  const looksLikeUrl = first !== undefined && /^[a-z][a-z0-9+.-]*:\/\//.test(first);
  const url = looksLikeUrl ? first : undefined;
  const remote = looksLikeUrl ? undefined : first;
  const ref = looksLikeUrl ? second : (second ?? undefined);

  let depth: number | undefined;
  if (parsed.flags.depth !== undefined) {
    const n = Number.parseInt(parsed.flags.depth as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      return {
        stdout: "",
        stderr: `git fetch: --depth requires a positive integer (got ${JSON.stringify(parsed.flags.depth)})\n`,
        exitCode: 129,
      };
    }
    depth = n;
  }

  if (url !== undefined && !isSupportedRemoteUrl(url)) {
    return {
      stdout: "",
      stderr: `git fetch: unsupported transport for '${url}'. Only https://, http://, and file:// are supported.\n`,
      exitCode: 1,
    };
  }

  let singleBranch: boolean | undefined;
  if (parsed.flags["single-branch"]) singleBranch = true;
  if (parsed.flags["no-single-branch"]) singleBranch = false;
  let tags: boolean | undefined;
  if (parsed.flags.tags) tags = true;
  if (parsed.flags["no-tags"]) tags = false;

  const dir = resolveDir(undefined, input.cwd);
  try {
    await client.fetch({
      dir,
      url,
      remote,
      ref,
      depth,
      singleBranch,
      tags,
      prune: parsed.flags.prune === true,
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("fetch", cause);
  }
}

// ---------------------------------------------------------------
// push
// ---------------------------------------------------------------

async function runPush(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git push [<remote>] [<ref>] [--force] [--delete]`
  const parsed = parseFlags(args, {
    force: { kind: "bool", alias: ["f"] },
    delete: { kind: "bool", alias: ["d"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git push: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git push: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [first, second] = parsed.positional;
  const looksLikeUrl = first !== undefined && /^[a-z][a-z0-9+.-]*:\/\//.test(first);
  const url = looksLikeUrl ? first : undefined;
  const remote = looksLikeUrl ? undefined : first;
  const refspec = parsePushRefspec(looksLikeUrl ? second : (second ?? undefined));

  if (url !== undefined && !isSupportedRemoteUrl(url)) {
    return {
      stdout: "",
      stderr: `git push: unsupported transport for '${url}'. Only https://, http://, and file:// are supported.\n`,
      exitCode: 1,
    };
  }

  const dir = resolveDir(undefined, input.cwd);
  try {
    const result = await client.push({
      dir,
      url,
      remote,
      ref: refspec.ref,
      remoteRef: refspec.remoteRef,
      force: parsed.flags.force === true,
      delete: parsed.flags.delete === true,
    });
    if (!result.ok) {
      const err = result.error ?? "push rejected";
      return { stdout: "", stderr: `git push: ${err}\n`, exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("push", cause);
  }
}

function parsePushRefspec(ref: string | undefined): { ref?: string; remoteRef?: string } {
  if (ref === undefined) return {};
  const colon = ref.indexOf(":");
  if (colon <= 0 || colon !== ref.lastIndexOf(":") || colon === ref.length - 1) {
    return { ref };
  }
  return { ref: ref.slice(0, colon), remoteRef: ref.slice(colon + 1) };
}

// ---------------------------------------------------------------
// pull
// ---------------------------------------------------------------

async function runPull(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git pull [<remote>] [<ref>] [--ff-only] [--no-ff]`
  const parsed = parseFlags(args, {
    "ff-only": { kind: "bool" },
    "no-ff": { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git pull: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 2) {
    return {
      stdout: "",
      stderr: `git pull: unexpected argument '${parsed.positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [first, second] = parsed.positional;
  const looksLikeUrl = first !== undefined && /^[a-z][a-z0-9+.-]*:\/\//.test(first);
  const url = looksLikeUrl ? first : undefined;
  const remote = looksLikeUrl ? undefined : first;
  const ref = looksLikeUrl ? second : (second ?? undefined);

  if (url !== undefined && !isSupportedRemoteUrl(url)) {
    return {
      stdout: "",
      stderr: `git pull: unsupported transport for '${url}'. Only https://, http://, and file:// are supported.\n`,
      exitCode: 1,
    };
  }

  const dir = resolveDir(undefined, input.cwd);
  try {
    await client.pull({
      dir,
      url,
      remote,
      ref,
      fastForwardOnly: parsed.flags["ff-only"] === true,
      fastForward: parsed.flags["no-ff"] === true ? false : undefined,
      env: input.env,
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("pull", cause);
  }
}

// ---------------------------------------------------------------
// merge
// ---------------------------------------------------------------

async function runMerge(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  const parsed = parseFlags(args, {
    "ff-only": { kind: "bool" },
    "no-ff": { kind: "bool" },
    message: { kind: "value", alias: ["m"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git merge: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length === 0) {
    return { stdout: "", stderr: "git merge: missing <ref>\n", exitCode: 129 };
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git merge: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const result = await client.merge({
      dir,
      theirs: parsed.positional[0],
      fastForwardOnly: parsed.flags["ff-only"] === true,
      fastForward: parsed.flags["no-ff"] === true ? false : undefined,
      message: parsed.flags.message as string | undefined,
      env: input.env,
    });
    if (result.alreadyMerged) {
      return { stdout: "Already up to date.\n", stderr: "", exitCode: 0 };
    }
    if (result.fastForward && result.oid) {
      return {
        stdout: `Fast-forward to ${result.oid.slice(0, 7)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    if (result.oid) {
      return {
        stdout: `Merge commit ${result.oid.slice(0, 7)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("merge", cause);
  }
}

// ---------------------------------------------------------------
// remote
// ---------------------------------------------------------------

async function runRemote(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git remote`              -> list (names only)
  // `git remote -v`           -> list (name + url, tab separated, twice)
  // `git remote add <n> <u>`  -> add
  // `git remote remove <n>`   -> remove
  const dir = resolveDir(undefined, input.cwd);
  if (args.length === 0) {
    try {
      const remotes = await client.remoteList({ dir });
      if (remotes.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
      return {
        stdout: `${remotes
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => r.name)
          .join("\n")}\n`,
        stderr: "",
        exitCode: 0,
      };
    } catch (cause) {
      return mapGitError("remote", cause);
    }
  }
  // `-v` lives at the top level, no subcommand.
  if (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) {
    try {
      const remotes = await client.remoteList({ dir });
      if (remotes.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
      const lines: string[] = [];
      for (const r of remotes.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`${r.name}\t${r.url} (fetch)`);
        lines.push(`${r.name}\t${r.url} (push)`);
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("remote", cause);
    }
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const parsed = parseFlags(rest, { force: { kind: "bool", alias: ["f"] } });
      if ("error" in parsed) {
        return { stdout: "", stderr: `git remote add: ${parsed.error}\n`, exitCode: 129 };
      }
      if (parsed.positional.length !== 2) {
        return {
          stdout: "",
          stderr: "git remote add: usage: git remote add [--force] <name> <url>\n",
          exitCode: 129,
        };
      }
      const [name, url] = parsed.positional;
      if (!isSupportedRemoteUrl(url)) {
        return {
          stdout: "",
          stderr: `git remote add: unsupported transport for '${url}'.\n`,
          exitCode: 1,
        };
      }
      try {
        await client.remoteAdd({ dir, name, url, force: parsed.flags.force === true });
        return { stdout: "", stderr: "", exitCode: 0 };
      } catch (cause) {
        return mapGitError("remote", cause);
      }
    }
    case "remove":
    case "rm": {
      if (rest.length !== 1) {
        return {
          stdout: "",
          stderr: `git remote ${sub}: usage: git remote ${sub} <name>\n`,
          exitCode: 129,
        };
      }
      try {
        await client.remoteRemove({ dir, name: rest[0] });
        return { stdout: "", stderr: "", exitCode: 0 };
      } catch (cause) {
        return mapGitError("remote", cause);
      }
    }
    default:
      return {
        stdout: "",
        stderr: `git remote: unknown subcommand '${sub}'\n`,
        exitCode: 129,
      };
  }
}

// ---------------------------------------------------------------
// hash-object
// ---------------------------------------------------------------

async function runHashObject(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git hash-object [-w] --stdin` -- the only mode we cover.
  // The on-disk file path form (`git hash-object <file>`) would
  // pull in path resolution and a Uint8Array readback through
  // the workspace's fs; the stdin form is enough for the agent
  // scripts that drive the shell side.
  const parsed = parseFlags(args, {
    w: { kind: "bool" },
    stdin: { kind: "bool" },
  });
  if ("error" in parsed) {
    return {
      stdout: "",
      stderr: `git hash-object: ${parsed.error}\n`,
      exitCode: 129,
    };
  }
  if (parsed.flags.stdin !== true) {
    return {
      stdout: "",
      stderr: "git hash-object: only --stdin is supported\n",
      exitCode: 129,
    };
  }
  if (parsed.positional.length > 0) {
    return {
      stdout: "",
      stderr: `git hash-object: unexpected argument '${parsed.positional[0]}'\n`,
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const oid = await client.hashObject({
      dir,
      content: input.stdin ?? "",
      write: parsed.flags.w === true,
    });
    return { stdout: `${oid}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("hash-object", cause);
  }
}

// ---------------------------------------------------------------
// cat-file
// ---------------------------------------------------------------

async function runCatFile(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git cat-file -p <oid>` -- pretty-print the object's raw
  // bytes to stdout. Other forms (`-t`, `-s`) are out of scope.
  const parsed = parseFlags(args, {
    p: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git cat-file: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.flags.p !== true) {
    return {
      stdout: "",
      stderr: "git cat-file: only -p is supported\n",
      exitCode: 129,
    };
  }
  if (parsed.positional.length !== 1) {
    return {
      stdout: "",
      stderr: "git cat-file: usage: git cat-file -p <oid>[:<path>]\n",
      exitCode: 129,
    };
  }
  // Support the <oid>:<path> shorthand for tree subreads.
  const spec = parsed.positional[0];
  const colon = spec.indexOf(":");
  const oid = colon === -1 ? spec : spec.slice(0, colon);
  const filepath = colon === -1 ? undefined : spec.slice(colon + 1);
  const dir = resolveDir(undefined, input.cwd);
  try {
    const result = await client.catFile({ dir, oid, filepath });
    const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
    return { stdout: text, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("cat-file", cause);
  }
}

// ---------------------------------------------------------------
// update-ref
// ---------------------------------------------------------------

async function runUpdateRef(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git update-ref [--force] <ref> <value>` -- direct ref
  // write. The older `--symbolic` and the read-side `-d` are
  // out of scope for this surface.
  const parsed = parseFlags(args, {
    force: { kind: "bool" },
  });
  if ("error" in parsed) {
    return {
      stdout: "",
      stderr: `git update-ref: ${parsed.error}\n`,
      exitCode: 129,
    };
  }
  if (parsed.positional.length !== 2) {
    return {
      stdout: "",
      stderr: "git update-ref: usage: git update-ref [--force] <ref> <value>\n",
      exitCode: 129,
    };
  }
  const [ref, value] = parsed.positional;
  const dir = resolveDir(undefined, input.cwd);
  try {
    await client.updateRef({ dir, ref, value, force: parsed.flags.force === true });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("update-ref", cause);
  }
}

// ---------------------------------------------------------------
// config
// ---------------------------------------------------------------

async function runConfig(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git config <key>`              -> get
  // `git config --get-all <key>`    -> get all values
  // `git config <key> <value>`      -> set
  // `git config --add <key> <value>`-> append multi-valued
  // `git config --unset <key>`      -> unset
  const parsed = parseFlags(args, {
    get: { kind: "bool" },
    "get-all": { kind: "bool" },
    add: { kind: "bool" },
    unset: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git config: ${parsed.error}\n`, exitCode: 129 };
  }
  const dir = resolveDir(undefined, input.cwd);
  const getAll = parsed.flags["get-all"] === true;
  const wantUnset = parsed.flags.unset === true;
  const wantAdd = parsed.flags.add === true;

  if (wantUnset) {
    if (parsed.positional.length !== 1) {
      return {
        stdout: "",
        stderr: "git config: usage: git config --unset <key>\n",
        exitCode: 129,
      };
    }
    try {
      await client.configSet({ dir, path: parsed.positional[0], value: undefined });
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("config", cause);
    }
  }

  if (parsed.positional.length === 1) {
    // Get mode.
    try {
      const value = await client.configGet({
        dir,
        path: parsed.positional[0],
        all: getAll,
      });
      if (value === undefined) {
        // Real git exits 1 with no output when --get misses.
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      const text = Array.isArray(value) ? `${value.join("\n")}\n` : `${value}\n`;
      return { stdout: text, stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("config", cause);
    }
  }

  if (parsed.positional.length === 2) {
    const [path, value] = parsed.positional;
    try {
      await client.configSet({ dir, path, value, append: wantAdd });
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (cause) {
      return mapGitError("config", cause);
    }
  }

  // Used input directly; ignore unused.
  void input;
  return {
    stdout: "",
    stderr: "git config: usage: git config [--get-all|--add|--unset] <key> [<value>]\n",
    exitCode: 129,
  };
}

// ---------------------------------------------------------------
// stash
// ---------------------------------------------------------------

async function runStash(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git stash [push [-m <msg>]] | list | pop`. A bare `git
  // stash` is `push`, matching real git.
  const [sub, ...rest] = args;
  const op = sub ?? "push";
  const dir = resolveDir(undefined, input.cwd);

  switch (op) {
    case "push": {
      const parsed = parseFlags(rest, { message: { kind: "value", alias: ["m"] } });
      if ("error" in parsed) {
        return { stdout: "", stderr: `git stash: ${parsed.error}\n`, exitCode: 129 };
      }
      try {
        await client.stashPush({ dir, message: parsed.flags.message as string | undefined });
        return { stdout: "Saved working directory state\n", stderr: "", exitCode: 0 };
      } catch (cause) {
        return mapGitError("stash", cause);
      }
    }
    case "list": {
      try {
        const entries = await client.stashList({ dir });
        return {
          stdout: entries.length === 0 ? "" : `${entries.join("\n")}\n`,
          stderr: "",
          exitCode: 0,
        };
      } catch (cause) {
        return mapGitError("stash", cause);
      }
    }
    case "pop": {
      try {
        await client.stashPop({ dir });
        return { stdout: "", stderr: "", exitCode: 0 };
      } catch (cause) {
        return mapGitError("stash", cause);
      }
    }
    default:
      return {
        stdout: "",
        stderr: `git stash: unknown subcommand '${op}'\n`,
        exitCode: 129,
      };
  }
}

// ---------------------------------------------------------------
// reset
// ---------------------------------------------------------------

async function runReset(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git reset [--hard] [<ref>] [-- <paths>...]`. Path reset
  // unstages; `--hard` restores tracked files to the ref.
  const parsed = parseFlags(args, {
    hard: { kind: "bool" },
    soft: { kind: "bool" },
    mixed: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git reset: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.flags.soft === true) {
    return { stdout: "", stderr: "git reset: --soft is not supported\n", exitCode: 129 };
  }
  if (parsed.flags.mixed === true) {
    return { stdout: "", stderr: "git reset: --mixed is not supported\n", exitCode: 129 };
  }
  const sep = args.indexOf("--");
  const positional =
    sep === -1 ? parsed.positional : args.slice(0, sep).filter((a) => !a.startsWith("-"));
  const pathArgs = sep === -1 ? [] : args.slice(sep + 1);
  const dir = resolveDir(undefined, input.cwd);
  const hard = parsed.flags.hard === true;

  // A leading positional before `--` can be a ref; everything
  // after `--` is paths. Real git is more context-sensitive than
  // this subset, but handle the ubiquitous `git reset HEAD`
  // spelling explicitly so it resets all staged changes instead
  // of silently treating HEAD as a pathspec.
  let ref: string | undefined;
  let paths = pathArgs;
  if (sep === -1) {
    if (hard || isResetRefOnly(positional)) {
      ref = positional[0];
    } else {
      paths = positional;
    }
  } else {
    ref = positional[0];
  }

  try {
    const resolvedRef = await resolveRevisionRef(client, dir, ref);
    await client.reset({
      dir,
      hard,
      ref: resolvedRef,
      paths: paths.length > 0 ? paths : undefined,
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("reset", cause);
  }
}

function isResetRefOnly(positional: string[]): boolean {
  if (positional.length !== 1) return false;
  const value = positional[0];
  return value === "HEAD" || hasRevisionSuffix(value);
}

// ---------------------------------------------------------------
// clean
// ---------------------------------------------------------------

async function runClean(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git clean -f [-d] [-n|--dry-run]`. Real git refuses to act
  // without `-f`; mirror that so a bare `git clean` is a no-op
  // error rather than a destructive surprise. The flags are all
  // boolean, so expand any combined short cluster (`-fd`, `-fdn`)
  // into separate tokens before parsing.
  const expanded = expandShortBoolCluster(args, new Set(["f", "d", "n"]));
  const parsed = parseFlags(expanded, {
    force: { kind: "bool", alias: ["f"] },
    d: { kind: "bool" },
    "dry-run": { kind: "bool", alias: ["n"] },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git clean: ${parsed.error}\n`, exitCode: 129 };
  }
  const dryRun = parsed.flags["dry-run"] === true;
  if (parsed.flags.force !== true && !dryRun) {
    return {
      stdout: "",
      stderr: "git clean: refusing to clean without -f (or use -n to preview)\n",
      exitCode: 129,
    };
  }
  const dir = resolveDir(undefined, input.cwd);
  try {
    const removed = await client.clean({
      dir,
      directories: parsed.flags.d === true,
      dryRun,
    });
    if (removed.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
    const verb = dryRun ? "Would remove" : "Removing";
    const lines = removed.map((p) => `${verb} ${p}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  } catch (cause) {
    return mapGitError("clean", cause);
  }
}

// ---------------------------------------------------------------
// shared error mapping
// ---------------------------------------------------------------

/**
 * Map a `GitError` subclass to the standard `git: <message>`
 * stderr framing and a deterministic exit code:
 *
 *   NotARepositoryError, AlreadyInitializedError,
 *   MissingIdentityError, PathOutsideRepoError,
 *   PathspecNotFoundError -> 128
 *   any other GitError                                  -> 1
 *   non-Error                                          -> 1
 *
 * Matches real git's convention of using 128 for environmental
 * errors and 1 for "command ran but didn't succeed".
 */
function mapGitError(subcommand: string, cause: unknown): GitCliResult {
  if (cause instanceof NotARepositoryError) {
    return makeStderr(subcommand, cause.message, 128);
  }
  if (cause instanceof AlreadyInitializedError) {
    return makeStderr(subcommand, cause.message, 128);
  }
  if (cause instanceof MissingIdentityError) {
    return makeStderr(subcommand, cause.message, 128);
  }
  if (cause instanceof PathspecNotFoundError) {
    return makeStderr(subcommand, cause.message, 128);
  }
  if (cause instanceof GitError) {
    return makeStderr(subcommand, cause.message, 1);
  }
  return makeStderr(subcommand, errorMessage(cause), 1);
}

function makeStderr(subcommand: string, message: string, exitCode: number): GitCliResult {
  return { stdout: "", stderr: `git ${subcommand}: ${message}\n`, exitCode };
}

// ---------------------------------------------------------------
// argv parser
// ---------------------------------------------------------------

interface FlagSpec {
  // `bool`: presence sets `true`; `--flag=x` is an error.
  // `value`: requires a value, inline (`--flag=x`) or next argv (`--flag x`).
  // `value-or-bool`: bare `--flag` sets `true`; `--flag=x` sets the value.
  kind: "bool" | "value" | "value-or-bool";
  alias?: string[];
}

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

type ParseResult = ParsedFlags | { error: string };

/**
 * Hand-rolled GNU-ish long-option parser.
 *
 *   `--flag` / `--flag=value` / `--flag value` / `-x`
 *   `--` ends flag processing; everything after is positional.
 *
 * Unknown long flags are an error so a typo doesn't silently
 * fall through as a positional. Real git is laxer on this, but
 * the workspace surface is intentionally narrow.
 */
interface GlobalOptions {
  /** Argv with any leading global options removed. */
  argv: string[];
  /** Effective cwd after applying `-C`. */
  cwd: string | undefined;
}

/**
 * Pull leading global options off the front of argv. Only
 * `-C <path>` is supported today: it sets the working directory
 * the subcommand resolves its `dir` default against, matching
 * real git's top-level `-C`. A relative path joins onto the
 * current cwd. A second `-C` is rejected rather than stacked —
 * agent use only needs one.
 */
function parseGlobalOptions(
  argv: string[],
  cwd: string | undefined,
): GlobalOptions | { error: string } {
  let cwdOut = cwd;
  let seenC = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-C") {
      if (seenC) return { error: "multiple -C options are not supported" };
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        return { error: "option '-C' requires a value" };
      }
      cwdOut = value.startsWith("/") ? value : joinPath(cwdOut ?? "/", value);
      seenC = true;
      i += 2;
      continue;
    }
    break;
  }
  return { argv: argv.slice(i), cwd: cwdOut };
}

function parseFlags(args: string[], spec: Record<string, FlagSpec>): ParseResult {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const aliasMap = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias) for (const a of s.alias) aliasMap.set(a, name);
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      for (i++; i < args.length; i++) positional.push(args[i]);
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const s = spec[name];
      if (!s) return { error: `unknown option '--${name}'` };
      if (s.kind === "bool") {
        if (inlineValue !== undefined) {
          return { error: `option '--${name}' does not take a value` };
        }
        flags[name] = true;
        i++;
        continue;
      }
      if (s.kind === "value-or-bool") {
        // Bare `--flag` -> true; `--flag=x` -> x. The bare form
        // never consumes the next argv (it would be ambiguous
        // against a positional).
        flags[name] = inlineValue ?? true;
        i++;
        continue;
      }
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        i++;
        continue;
      }
      const next = args[i + 1];
      if (next === undefined) {
        return { error: `option '--${name}' requires a value` };
      }
      flags[name] = next;
      i += 2;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      // Look up by alias first; fall back to a spec entry whose
      // *name* is a single char matching the short form (so a
      // spec like `{ n: { kind: "value" } }` accepts `-n` without
      // declaring `alias: ["n"]`).
      const name = aliasMap.get(short) ?? (spec[short] ? short : undefined);
      if (!name) return { error: `unknown option '-${short}'` };
      const s = spec[name];
      if (s.kind === "bool" || s.kind === "value-or-bool") {
        flags[name] = true;
        i++;
        continue;
      }
      const next = args[i + 1];
      if (next === undefined) {
        return { error: `option '-${short}' requires a value` };
      }
      flags[name] = next;
      i += 2;
      continue;
    }
    positional.push(arg);
    i++;
  }
  return { flags, positional };
}

// ---------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------

function resolveDir(dirArg: string | undefined, cwd: string | undefined): string {
  if (dirArg !== undefined && dirArg !== "") {
    return dirArg.startsWith("/") ? dirArg : joinPath(cwd ?? "/", dirArg);
  }
  return cwd ?? "/";
}

function joinPath(base: string, segment: string): string {
  if (base.endsWith("/")) return `${base}${segment}`;
  return `${base}/${segment}`;
}

/**
 * Derive the default clone directory name from a repository URL,
 * mirroring real git: take the last non-empty path segment and
 * strip a trailing `.git`. Returns `undefined` when no usable
 * name can be extracted (e.g. the URL ends in a bare host or a
 * slash), so the caller can demand an explicit destination.
 */
function repoNameFromUrl(url: string): string | undefined {
  // Trim a query/fragment and trailing slashes before splitting.
  let s = url.split(/[?#]/, 1)[0];
  while (s.endsWith("/")) s = s.slice(0, -1);
  // Drop the scheme + authority so a host with no path doesn't
  // yield the host name as a repo name.
  const schemeEnd = s.indexOf("://");
  const afterScheme = schemeEnd === -1 ? s : s.slice(schemeEnd + 3);
  const firstSlash = afterScheme.indexOf("/");
  if (firstSlash === -1) return undefined;
  const path = afterScheme.slice(firstSlash + 1);
  const segment = path.split("/").pop();
  if (segment === undefined || segment === "") return undefined;
  const name = segment.endsWith(".git") ? segment.slice(0, -4) : segment;
  if (name === "" || name === "." || name === "..") return undefined;
  return name;
}

/** True when `ref` carries a `gitrevisions(7)` ancestry suffix. */
function hasRevisionSuffix(ref: string): boolean {
  return /[\^~]/.test(ref);
}

/**
 * Resolve a ref that may carry a revision suffix (`HEAD^`,
 * `HEAD~2`, ...) to a concrete oid via `rev-parse`, which owns
 * the suffix-walking logic. A plain ref is returned untouched so
 * the downstream method keeps resolving branch / tag names
 * itself. Used by subcommands whose typed methods call
 * `resolveRef` directly and so don't understand the suffix
 * grammar.
 */
async function resolveRevisionRef(
  client: GitClient,
  dir: string,
  ref: string | undefined,
): Promise<string | undefined> {
  if (ref === undefined || !hasRevisionSuffix(ref)) return ref;
  return client.revParse({ dir, ref });
}

function isSupportedRemoteUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("file://");
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
