// Working-tree manipulation: stash, reset, and clean.
//
// `stash` and `reset` wrap isomorphic-git directly. `clean` has
// no isomorphic-git equivalent, so it derives the untracked set
// from a status-matrix walk and removes paths through the
// filesystem. Each wrapper centralises dir / cache plumbing and
// throws the typed NotARepositoryError when the gitdir is
// missing.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

// ---------------------------------------------------------------
// stash
// ---------------------------------------------------------------

/** Subset of `isomorphic-git`'s API used for `stash`. */
export interface IsomorphicGitStashClient {
  stash(args: {
    fs: object;
    dir: string;
    op?: "push" | "pop" | "apply" | "drop" | "list" | "clear";
    message?: string;
    refIdx?: number;
  }): Promise<string | string[] | undefined>;
}

export interface BaseWorktreeOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
}

export interface StashPushOptions extends BaseWorktreeOptions {
  /** Optional stash message. */
  message?: string;
}

export interface StashPushWithDeps extends StashPushOptions {
  git: IsomorphicGitStashClient;
  fs: object;
}

export async function stashPushWith(opts: StashPushWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.stash({ fs: opts.fs, dir, op: "push", message: opts.message });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESTASHFAIL", `git stash push failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface StashListWithDeps extends BaseWorktreeOptions {
  git: IsomorphicGitStashClient;
  fs: object;
}

/** Stash entries, newest first, as `stash@{N}: <message>` strings. */
export async function stashListWith(opts: StashListWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  try {
    const list = await opts.git.stash({ fs: opts.fs, dir, op: "list" });
    return Array.isArray(list) ? list : [];
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESTASHFAIL", `git stash list failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface StashPopOptions extends BaseWorktreeOptions {
  /** Stash index to pop. Defaults to the latest (0). */
  index?: number;
}

export interface StashPopWithDeps extends StashPopOptions {
  git: IsomorphicGitStashClient;
  fs: object;
}

export async function stashPopWith(opts: StashPopWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.stash({ fs: opts.fs, dir, op: "pop", refIdx: opts.index ?? 0 });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESTASHFAIL", `git stash pop failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// reset
// ---------------------------------------------------------------

/** Subset of `isomorphic-git`'s API used for `reset`. */
export interface IsomorphicGitResetClient {
  resetIndex(args: {
    fs: object;
    dir: string;
    filepath: string;
    ref?: string;
    cache?: object;
  }): Promise<void>;
  checkout(args: {
    fs: object;
    dir: string;
    ref: string;
    force?: boolean;
    cache?: object;
  }): Promise<void>;
}

export interface ResetOptions extends BaseWorktreeOptions {
  /**
   * Paths to unstage against `ref`. Mutually exclusive with
   * `hard`; when set, the index entries for these paths are reset
   * to `ref` (default HEAD) and the working tree is left alone.
   */
  paths?: string[];
  /**
   * Discard staged and working-tree changes, restoring tracked
   * files to `ref`. Equivalent to `git reset --hard`.
   */
  hard?: boolean;
  /** Commit-ish to reset to. Defaults to HEAD. */
  ref?: string;
}

export interface ResetWithDeps extends ResetOptions {
  git: IsomorphicGitResetClient;
  fs: object;
  cache?: object;
}

export async function resetWith(opts: ResetWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  const ref = opts.ref ?? "HEAD";
  try {
    if (opts.hard) {
      // Hard reset: force-checkout the ref, which rewrites both
      // the index and the working tree to match.
      await opts.git.checkout({ fs: opts.fs, dir, ref, force: true, cache: opts.cache });
      return;
    }
    // Path reset: unstage each path back to `ref` without
    // touching the working tree.
    for (const filepath of opts.paths ?? []) {
      await opts.git.resetIndex({ fs: opts.fs, dir, filepath, ref, cache: opts.cache });
    }
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ERESETFAIL", `git reset failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// clean
// ---------------------------------------------------------------

/** Subset of `isomorphic-git`'s API used for `clean`. */
export interface IsomorphicGitCleanClient {
  statusMatrix(args: {
    fs: object;
    dir: string;
    cache?: object;
  }): Promise<Array<[string, number, number, number]>>;
}

/** `fs.promises` surface used to remove paths. */
interface RemoveFsClient {
  promises: {
    rm?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    rmdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  };
}

export interface CleanOptions extends BaseWorktreeOptions {
  /** Remove untracked directories too (`-d`). */
  directories?: boolean;
  /** List what would be removed without removing it (`--dry-run`). */
  dryRun?: boolean;
}

export interface CleanWithDeps extends CleanOptions {
  git: IsomorphicGitCleanClient;
  fs: object;
  cache?: object;
}

/**
 * Remove untracked paths under the repository, mirroring `git
 * clean -f [-d]`. Returns the repo-relative paths removed (or
 * that would be removed under `dryRun`). Untracked files in
 * tracked directories are always eligible; untracked directories
 * and their contents only when `directories` is set, matching
 * real git's refusal to descend into untracked directories
 * without `-d`. Ignored-file handling is not modeled — every
 * untracked path is a candidate.
 */
export async function cleanWith(opts: CleanWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  let matrix: Array<[string, number, number, number]>;
  try {
    matrix = await opts.git.statusMatrix({ fs: opts.fs, dir, cache: opts.cache });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECLEANFAIL", `git clean failed: ${errorMessage(cause)}`, { cause });
  }

  // Tracked directories: every ancestor of a path present in HEAD
  // or the index. The repo root (".") is tracked whenever any
  // file is. Untracked files whose parent is tracked are loose
  // files; those nested under an untracked directory are grouped
  // under that directory.
  const trackedDirs = new Set<string>(["."]);
  const untrackedFiles: string[] = [];
  for (const [path, head, _workdir, stage] of matrix) {
    if (head === 1 || stage !== 0) {
      for (const ancestor of ancestorDirs(path)) trackedDirs.add(ancestor);
    } else {
      untrackedFiles.push(path);
    }
  }

  const looseFiles: string[] = [];
  const untrackedTopDirs = new Set<string>();
  for (const path of untrackedFiles) {
    const parent = dirname(path);
    if (trackedDirs.has(parent)) {
      looseFiles.push(path);
    } else {
      untrackedTopDirs.add(topmostUntrackedDir(path, trackedDirs));
    }
  }

  const removed = [...looseFiles];
  if (opts.directories) removed.push(...untrackedTopDirs);
  removed.sort();

  if (opts.dryRun) return removed;

  const fs = opts.fs as RemoveFsClient;
  for (const rel of removed) {
    const abs = dir === "/" ? `/${rel}` : `${dir}/${rel}`;
    await removePath(fs, abs);
  }
  return removed;
}

async function removePath(fs: RemoveFsClient, abs: string): Promise<void> {
  if (typeof fs.promises.rm === "function") {
    await fs.promises.rm(abs, { recursive: true, force: true });
    return;
  }
  // Fallback for fs implementations without `rm`: try unlink,
  // then a recursive rmdir.
  try {
    await fs.promises.unlink(abs);
  } catch {
    if (typeof fs.promises.rmdir === "function") {
      await fs.promises.rmdir(abs, { recursive: true });
    }
  }
}

function ancestorDirs(path: string): string[] {
  const out: string[] = [];
  let p = dirname(path);
  while (p !== ".") {
    out.push(p);
    p = dirname(p);
  }
  return out;
}

function topmostUntrackedDir(path: string, trackedDirs: Set<string>): string {
  // Walk from the file up to the root; the first dir off the root
  // that isn't tracked is the top of the untracked subtree.
  const segments = path.split("/");
  let prefix = "";
  for (let i = 0; i < segments.length - 1; i++) {
    prefix = prefix === "" ? segments[i] : `${prefix}/${segments[i]}`;
    if (!trackedDirs.has(prefix)) return prefix;
  }
  return dirname(path);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
