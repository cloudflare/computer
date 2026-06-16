// `git add` and `git rm` — index manipulation.
//
// Both surface an array of `paths` rather than the single
// `filepath` isomorphic-git takes, because the CLI's positional
// arguments naturally come in plural and a `paths: string[]`
// shape removes the per-call loop from every caller.

import {
  GitError,
  isNotARepositoryCause,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";

/** Subset of `isomorphic-git`'s API used for `add`. */
export interface IsomorphicGitAddClient {
  add(args: {
    fs: object;
    dir: string;
    filepath: string | string[];
    cache?: object;
    force?: boolean;
  }): Promise<void>;
  /** Used by `all` mode to enumerate changed paths. */
  statusMatrix(args: {
    fs: object;
    dir: string;
    cache?: object;
  }): Promise<Array<[string, number, number, number]>>;
  /** Used by `all` mode to stage deletions. */
  remove(args: { fs: object; dir: string; filepath: string; cache?: object }): Promise<void>;
}

/** Subset of `isomorphic-git`'s API used for `rm`. */
export interface IsomorphicGitRmClient {
  remove(args: { fs: object; dir: string; filepath: string; cache?: object }): Promise<void>;
}

export interface GitAddOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /**
   * Paths to stage, relative to `dir`. Empty array is a no-op
   * (matching `git add` with no arguments — which exits 0 with a
   * usage message; the CLI catches the no-arg case before
   * calling). Absolute or `..`-bearing paths are rejected at the
   * call site.
   */
  paths: string[];
  /**
   * Stage even paths that match `.gitignore`. isomorphic-git's
   * `add` honours ignore patterns by default; pass `true` to
   * override.
   */
  force?: boolean;
  /**
   * Stage every change under the repository — new, modified, and
   * deleted tracked files — the way `git add -A` / `--all` does.
   * When set, `paths` is ignored. Deletions are staged through
   * `remove`, which `add` alone cannot express.
   */
  all?: boolean;
  /**
   * Restrict `all` mode to paths already tracked in HEAD — the
   * `git commit -a` semantics, which stage modifications and
   * deletions but never add untracked files. Ignored unless
   * `all` is set.
   */
  trackedOnly?: boolean;
}

export interface AddWithDeps extends GitAddOptions {
  git: IsomorphicGitAddClient;
  fs: object;
  cache?: object;
}

export async function addWith(opts: AddWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  if (opts.all) {
    return addAll(opts, dir);
  }
  if (opts.paths.length === 0) return;
  try {
    // isomorphic-git 1.27+ accepts an array; older versions only
    // accept a single string. We pass the array and let it fan
    // out; the version pinned by the repo (^1.x) supports this.
    await opts.git.add({
      fs: opts.fs,
      dir,
      filepath: opts.paths,
      cache: opts.cache,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    if (looksLikePathspecMiss(cause)) {
      throw new PathspecNotFoundError(firstPathspec(opts.paths), { cause });
    }
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }
}

/**
 * Stage every working-tree change. Walks the status matrix and
 * splits the work: present-but-changed paths go through `add`,
 * worktree-deleted paths go through `remove` (which `add` cannot
 * express). The status-matrix tuple is `[path, head, workdir,
 * stage]`; `workdir === 0` means the file is gone from disk.
 */
async function addAll(opts: AddWithDeps, dir: string): Promise<void> {
  let matrix: Array<[string, number, number, number]>;
  try {
    matrix = await opts.git.statusMatrix({ fs: opts.fs, dir, cache: opts.cache });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [filepath, head, workdir, stage] of matrix) {
    // `commit -a` semantics: only touch paths already in HEAD,
    // so untracked files (head === 0) are left alone.
    if (opts.trackedOnly && head !== 1) continue;
    if (workdir === 0) {
      // Gone from the working tree. Only stage the deletion when
      // it isn't already staged (head present, stage present).
      if (head === 1 && stage !== 0) toRemove.push(filepath);
      continue;
    }
    // Present on disk and differs from the staged copy.
    if (workdir !== 1 || stage !== 1) toAdd.push(filepath);
  }

  try {
    if (toAdd.length > 0) {
      await opts.git.add({
        fs: opts.fs,
        dir,
        filepath: toAdd,
        cache: opts.cache,
        force: opts.force,
      });
    }
    for (const filepath of toRemove) {
      await opts.git.remove({ fs: opts.fs, dir, filepath, cache: opts.cache });
    }
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface GitRmOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Paths to unstage, relative to `dir`. */
  paths: string[];
}

export interface RmWithDeps extends GitRmOptions {
  git: IsomorphicGitRmClient;
  fs: object;
  cache?: object;
}

export async function rmWith(opts: RmWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  for (const filepath of opts.paths) {
    try {
      await opts.git.remove({ fs: opts.fs, dir, filepath, cache: opts.cache });
    } catch (cause) {
      if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
      if (looksLikePathspecMiss(cause)) {
        throw new PathspecNotFoundError(filepath, { cause });
      }
      throw new GitError("ERMFAIL", `git rm failed: ${errorMessage(cause)}`, { cause });
    }
  }
}

function looksLikePathspecMiss(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const m = cause.message.toLowerCase();
  return m.includes("could not find") || m.includes("not in the index") || m.includes("enoent");
}

function firstPathspec(paths: string[]): string {
  return paths[0] ?? "";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
