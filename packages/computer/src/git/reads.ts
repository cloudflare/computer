// Read-only git operations: log, show, revParse, currentBranch,
// lsFiles, lsTree. Each is a thin wrapper around isomorphic-git;
// the wrapper exists to centralise the dir / cache plumbing and
// to throw the typed NotARepositoryError when the gitdir is
// missing.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

export interface GitPerson {
  name: string;
  email: string;
  /** Seconds since epoch. */
  timestamp: number;
  /** Minutes east of UTC. */
  timezoneOffset: number;
}

export interface CommitView {
  oid: string;
  message: string;
  tree: string;
  parent: string[];
  author: GitPerson;
  committer: GitPerson;
}

export interface TreeEntryView {
  /** 6-digit hex mode as isomorphic-git emits it ('100644', '040000', ...). */
  mode: string;
  /** Entry name (no leading path). */
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** isomorphic-git's subset used here. */
export interface IsomorphicGitReadsClient {
  log(args: { fs: object; dir: string; ref?: string; depth?: number; cache?: object }): Promise<
    Array<{
      oid: string;
      commit: {
        message: string;
        tree: string;
        parent: string[];
        author: GitPerson;
        committer: GitPerson;
      };
    }>
  >;
  readCommit(args: { fs: object; dir: string; oid: string; cache?: object }): Promise<{
    oid: string;
    commit: {
      message: string;
      tree: string;
      parent: string[];
      author: GitPerson;
      committer: GitPerson;
    };
  }>;
  resolveRef(args: { fs: object; dir: string; ref: string }): Promise<string>;
  expandOid(args: { fs: object; dir: string; oid: string; cache?: object }): Promise<string>;
  // isomorphic-git's declared return type is `string | void`
  // for the detached-HEAD case. The actual runtime value is
  // `undefined`; we declare it that way to keep the structural
  // shape JS-friendly.
  currentBranch(args: { fs: object; dir: string; fullname?: boolean }): Promise<string | undefined>;
  listFiles(args: { fs: object; dir: string; ref?: string; cache?: object }): Promise<string[]>;
  readTree(args: {
    fs: object;
    dir: string;
    oid: string;
    filepath?: string;
    cache?: object;
  }): Promise<{
    oid: string;
    tree: Array<{ mode: string; path: string; oid: string; type: string }>;
  }>;
}

export interface BaseReadOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
}

// ---------------------------------------------------------------
// log
// ---------------------------------------------------------------

export interface GitLogOptions extends BaseReadOptions {
  /** Ref to start the walk at. Defaults to HEAD. */
  ref?: string;
  /** Max commits to return. Defaults to unbounded. */
  depth?: number;
}

export interface LogWithDeps extends GitLogOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function logWith(opts: LogWithDeps): Promise<CommitView[]> {
  const dir = opts.dir ?? "/";
  let entries: Awaited<ReturnType<IsomorphicGitReadsClient["log"]>>;
  try {
    entries = await opts.git.log({
      fs: opts.fs,
      dir,
      ref: opts.ref ?? "HEAD",
      depth: opts.depth,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELOGFAIL", `git log failed: ${errorMessage(cause)}`, { cause });
  }
  return entries.map((e) => ({
    oid: e.oid,
    message: e.commit.message,
    tree: e.commit.tree,
    parent: e.commit.parent,
    author: e.commit.author,
    committer: e.commit.committer,
  }));
}

// ---------------------------------------------------------------
// show
// ---------------------------------------------------------------

export interface GitShowOptions extends BaseReadOptions {
  /** Object to show. Today: a commit oid or a ref that resolves to one. */
  ref: string;
}

export interface ShowWithDeps extends GitShowOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function showWith(opts: ShowWithDeps): Promise<CommitView> {
  const dir = opts.dir ?? "/";
  try {
    const oid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: opts.ref });
    const { commit } = await opts.git.readCommit({
      fs: opts.fs,
      dir,
      oid,
      cache: opts.cache,
    });
    return {
      oid,
      message: commit.message,
      tree: commit.tree,
      parent: commit.parent,
      author: commit.author,
      committer: commit.committer,
    };
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESHOWFAIL", `git show failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// rev-parse
// ---------------------------------------------------------------

export interface GitRevParseOptions extends BaseReadOptions {
  /** Ref to resolve. */
  ref: string;
}

export interface RevParseWithDeps extends GitRevParseOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function revParseWith(opts: RevParseWithDeps): Promise<string> {
  const dir = opts.dir ?? "/";
  try {
    const { base, steps } = parseRevision(opts.ref);
    let oid: string;
    try {
      oid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: base });
    } catch (cause) {
      if (!isNotFoundCause(cause) || !isAbbreviatedOid(base)) throw cause;
      oid = await opts.git.expandOid({
        fs: opts.fs,
        dir,
        oid: base.toLowerCase(),
        cache: opts.cache,
      });
    }
    for (const step of steps) {
      oid = await walkParent(opts, dir, oid, step);
    }
    return oid;
  } catch (cause) {
    if (cause instanceof GitError) throw cause;
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EREVPARSEFAIL", `git rev-parse failed: ${errorMessage(cause)}`, { cause });
  }
}

function isNotFoundCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name === "NotFoundError" || (cause as { code?: unknown }).code === "NotFoundError";
}

function isAbbreviatedOid(ref: string): boolean {
  return ref.length < 40 && /^[0-9a-f]+$/i.test(ref);
}

/**
 * A single ancestry step parsed off a revision spec. `^` and `~N`
 * both walk toward parents; `n` records which parent (1-based)
 * each step follows. `~N` expands to N first-parent steps; `^`
 * is one step toward parent `n` (default 1); `^N` selects parent
 * N. See gitrevisions(7).
 */
interface RevStep {
  /** 1-based parent index. */
  n: number;
}

/**
 * Split a revision into its base ref and the ancestry walk that
 * follows. Supports the common `gitrevisions(7)` suffixes:
 *
 *   <ref>        -> { base: <ref>, steps: [] }
 *   <ref>^       -> one step to parent 1
 *   <ref>^N      -> one step to parent N
 *   <ref>~N      -> N steps, each to parent 1
 *
 * Suffixes chain left to right, so `HEAD~2^2` is two first-parent
 * steps then a second-parent step.
 */
function parseRevision(ref: string): { base: string; steps: RevStep[] } {
  // Find where the suffix operators begin. A bare oid or ref has
  // none. We only treat trailing `^`/`~` runs as operators.
  const match = /^(.*?)((?:[\^~][0-9]*)*)$/.exec(ref);
  if (!match || match[2] === "") return { base: ref, steps: [] };
  const base = match[1];
  const suffix = match[2];
  const steps: RevStep[] = [];
  const tokens = suffix.match(/[\^~][0-9]*/g) ?? [];
  for (const token of tokens) {
    const op = token[0];
    const num = token.slice(1);
    if (op === "~") {
      // `~` with no number means `~1`. `~N` is N first-parent
      // hops.
      const count = num === "" ? 1 : Number.parseInt(num, 10);
      for (let i = 0; i < count; i++) steps.push({ n: 1 });
    } else {
      // `^` with no number means parent 1. `^N` selects parent N.
      const n = num === "" ? 1 : Number.parseInt(num, 10);
      // `^0` means the commit itself — no walk.
      if (n === 0) continue;
      steps.push({ n });
    }
  }
  return { base, steps };
}

async function walkParent(
  opts: RevParseWithDeps,
  dir: string,
  oid: string,
  step: RevStep,
): Promise<string> {
  const { commit } = await opts.git.readCommit({ fs: opts.fs, dir, oid });
  const parent = commit.parent[step.n - 1];
  if (parent === undefined) {
    throw new GitError(
      "EREVPARSEFAIL",
      `git rev-parse failed: ${oid.slice(0, 7)} has no parent ${step.n}`,
    );
  }
  return parent;
}

// ---------------------------------------------------------------
// repo-root (rev-parse --show-toplevel)
// ---------------------------------------------------------------

export interface GitRepoRootOptions extends BaseReadOptions {}

/** Minimal `fs.promises` surface used to probe for `.git`. */
interface StatFsClient {
  promises: {
    stat(path: string): Promise<unknown>;
  };
}

export interface RepoRootWithDeps extends GitRepoRootOptions {
  fs: object;
}

/**
 * Walk upward from `dir` until a `.git` entry is found and return
 * that directory — the equivalent of `git rev-parse
 * --show-toplevel`. Paths are workspace-absolute and POSIX. Throws
 * `NotARepositoryError` when the walk reaches the root without
 * finding a `.git`.
 */
export async function repoRootWith(opts: RepoRootWithDeps): Promise<string> {
  const start = normalizeAbsolute(opts.dir ?? "/");
  const fs = opts.fs as StatFsClient;
  let current = start;
  while (true) {
    const gitPath = current === "/" ? "/.git" : `${current}/.git`;
    try {
      await fs.promises.stat(gitPath);
      return current;
    } catch {
      // Not here; climb one level.
    }
    if (current === "/") break;
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
  throw new NotARepositoryError(start);
}

function normalizeAbsolute(p: string): string {
  // Collapse a trailing slash (except the root) so the parent
  // walk doesn't stall on `/foo/`.
  let out = p.startsWith("/") ? p : `/${p}`;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

// ---------------------------------------------------------------
// current-branch
// ---------------------------------------------------------------

export interface GitCurrentBranchOptions extends BaseReadOptions {
  /** Return refs/heads/<name> instead of <name>. */
  fullname?: boolean;
}

export interface CurrentBranchWithDeps extends GitCurrentBranchOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
}

/**
 * Returns the current branch name, or `undefined` for detached
 * HEAD (matching `git symbolic-ref -q HEAD`'s exit-1 case).
 */
export async function currentBranchWith(opts: CurrentBranchWithDeps): Promise<string | undefined> {
  const dir = opts.dir ?? "/";
  try {
    const name = await opts.git.currentBranch({
      fs: opts.fs,
      dir,
      fullname: opts.fullname,
    });
    return name ?? undefined;
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECURRENTBRANCHFAIL", `git symbolic-ref failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// ls-files
// ---------------------------------------------------------------

export interface GitLsFilesOptions extends BaseReadOptions {
  /** List files in this ref's tree instead of the index. */
  ref?: string;
}

export interface LsFilesWithDeps extends GitLsFilesOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function lsFilesWith(opts: LsFilesWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.listFiles({
      fs: opts.fs,
      dir,
      ref: opts.ref,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELSFILESFAIL", `git ls-files failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// ls-tree
// ---------------------------------------------------------------

export interface GitLsTreeOptions extends BaseReadOptions {
  /** Tree-ish to list. */
  ref: string;
  /** Sub-path within the tree. Defaults to the root. */
  path?: string;
}

export interface LsTreeWithDeps extends GitLsTreeOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function lsTreeWith(opts: LsTreeWithDeps): Promise<TreeEntryView[]> {
  const dir = opts.dir ?? "/";
  try {
    const oid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: opts.ref });
    const { tree } = await opts.git.readTree({
      fs: opts.fs,
      dir,
      oid,
      filepath: opts.path,
      cache: opts.cache,
    });
    return tree.map((e) => ({
      mode: e.mode,
      path: e.path,
      oid: e.oid,
      type: (e.type ?? inferType(e.mode)) as TreeEntryView["type"],
    }));
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELSTREEFAIL", `git ls-tree failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

function inferType(mode: string): "blob" | "tree" | "commit" {
  if (mode.startsWith("04")) return "tree";
  if (mode === "160000") return "commit";
  return "blob";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
