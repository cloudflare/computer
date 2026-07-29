// Local ref movement: branch, tag, checkout.
//
// Each operation is a thin wrapper around isomorphic-git plus the
// typed-error mapping that the wider surface uses. The CLI's
// argv branches live in cli.ts and call straight into these.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

/** isomorphic-git's subset used by branch / tag / checkout. */
export interface IsomorphicGitRefsClient {
  branch(args: {
    fs: object;
    dir: string;
    ref: string;
    object?: string;
    checkout?: boolean;
    force?: boolean;
  }): Promise<void>;
  deleteBranch(args: { fs: object; dir: string; ref: string }): Promise<void>;
  listBranches(args: { fs: object; dir: string }): Promise<string[]>;
  tag(args: {
    fs: object;
    dir: string;
    ref: string;
    object?: string;
    force?: boolean;
  }): Promise<void>;
  deleteTag(args: { fs: object; dir: string; ref: string }): Promise<void>;
  listTags(args: { fs: object; dir: string }): Promise<string[]>;
  checkout(args: {
    fs: object;
    dir: string;
    ref: string;
    filepaths?: string[];
    force?: boolean;
    noUpdateHead?: boolean;
    cache?: object;
  }): Promise<void>;
}

// ---------------------------------------------------------------
// branch
// ---------------------------------------------------------------

export interface GitBranchOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Branch name to create. */
  name: string;
  /** Commit-ish the branch points at. Defaults to HEAD. */
  startPoint?: string;
  /** Move HEAD to the new branch. Defaults to `false`. */
  checkout?: boolean;
  /** Overwrite an existing branch with the same name. */
  force?: boolean;
}

export interface BranchWithDeps extends GitBranchOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function branchWith(opts: BranchWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.branch({
      fs: opts.fs,
      dir,
      ref: opts.name,
      object: opts.startPoint,
      checkout: opts.checkout,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EBRANCHFAIL", `git branch failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export interface GitBranchDeleteOptions {
  dir?: string;
  name: string;
}

export interface BranchDeleteWithDeps extends GitBranchDeleteOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function branchDeleteWith(opts: BranchDeleteWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.deleteBranch({ fs: opts.fs, dir, ref: opts.name });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EBRANCHFAIL", `git branch -d failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export interface GitBranchListOptions {
  dir?: string;
}

export interface BranchListWithDeps extends GitBranchListOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function branchListWith(opts: BranchListWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.listBranches({ fs: opts.fs, dir });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EBRANCHFAIL", `git branch list failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// tag
// ---------------------------------------------------------------

export interface GitTagOptions {
  dir?: string;
  /** Tag name. */
  name: string;
  /** Commit-ish to tag. Defaults to HEAD. */
  object?: string;
  /** Overwrite an existing tag. */
  force?: boolean;
}

export interface TagWithDeps extends GitTagOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function tagWith(opts: TagWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.tag({
      fs: opts.fs,
      dir,
      ref: opts.name,
      object: opts.object,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ETAGFAIL", `git tag failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface GitTagDeleteOptions {
  dir?: string;
  name: string;
}

export interface TagDeleteWithDeps extends GitTagDeleteOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function tagDeleteWith(opts: TagDeleteWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.deleteTag({ fs: opts.fs, dir, ref: opts.name });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ETAGFAIL", `git tag -d failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface GitTagListOptions {
  dir?: string;
}

export interface TagListWithDeps extends GitTagListOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
}

export async function tagListWith(opts: TagListWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.listTags({ fs: opts.fs, dir });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ETAGFAIL", `git tag list failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// checkout
// ---------------------------------------------------------------

export interface GitCheckoutOptions {
  dir?: string;
  /** Branch, tag, or commit to check out. */
  ref: string;
  /**
   * Restrict the checkout to these paths. When set, HEAD does
   * not move (matching `git checkout <ref> -- <paths>`); the
   * working tree is updated to match `ref` for those paths only.
   */
  paths?: string[];
  /** Discard local changes that would conflict with the checkout. */
  force?: boolean;
}

export interface CheckoutWithDeps extends GitCheckoutOptions {
  git: IsomorphicGitRefsClient;
  fs: object;
  cache?: object;
}

export async function checkoutWith(opts: CheckoutWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  // git checkout <ref> -- <paths>: update the working tree but
  // leave HEAD where it was. isomorphic-git's `noUpdateHead`
  // achieves this; without it a path-restricted checkout would
  // detach HEAD onto the source commit.
  const pathScoped = opts.paths !== undefined && opts.paths.length > 0;
  try {
    await opts.git.checkout({
      fs: opts.fs,
      dir,
      ref: opts.ref,
      filepaths: pathScoped ? opts.paths : undefined,
      force: opts.force,
      noUpdateHead: pathScoped,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECHECKOUTFAIL", `git checkout failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
