// Network operations: fetch, pull, push, plus remote management
// and the local merge that pull builds on.
//
// All five take the same auth contract: a `headers` map applied
// verbatim to each HTTP request and an `onAuth` callback the
// remote can invoke when it gets a 401. The shape mirrors
// isomorphic-git's so a caller already familiar with its surface
// sees nothing surprising; the workspace wrapper centralizes
// error mapping and the cache plumbing.
//
// SSH transport is explicitly out of scope. isomorphic-git has
// none, and the CLI dispatcher rejects ssh:// URLs at the
// argument-parsing boundary.

import {
  GitError,
  isNotARepositoryCause,
  MissingIdentityError,
  NotARepositoryError,
} from "./errors.js";

/** Shape isomorphic-git accepts for HTTP basic / bearer auth. */
export interface GitAuth {
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

/** Auth callback signature shared by every network operation. */
export type AuthCallback = (
  url: string,
  auth: GitAuth,
) => GitAuth | undefined | undefined | Promise<GitAuth | undefined | undefined>;

/** Progress callback shared with clone (see clone.ts). */
export type ProgressCallback = (e: { phase: string; loaded: number; total?: number }) => void;
/** Sideband message callback shared with clone. */
export type MessageCallback = (msg: string) => void;

/** Per-ref status emitted by `push`. */
export interface RefUpdateStatus {
  ok: boolean;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  error: string | null;
  refs: Record<string, RefUpdateStatus>;
}

/** isomorphic-git subset used by the network family. */
export interface IsomorphicGitNetworkClient {
  fetch(args: {
    fs: object;
    http: object;
    dir: string;
    url?: string;
    remote?: string;
    ref?: string;
    remoteRef?: string;
    depth?: number;
    singleBranch?: boolean;
    tags?: boolean;
    prune?: boolean;
    headers?: Record<string, string>;
    onAuth?: AuthCallback;
    onProgress?: ProgressCallback;
    onMessage?: MessageCallback;
    cache?: object;
  }): Promise<{ defaultBranch: string | null; fetchHead: string | null }>;
  push(args: {
    fs: object;
    http: object;
    dir: string;
    url?: string;
    remote?: string;
    ref?: string;
    remoteRef?: string;
    force?: boolean;
    delete?: boolean;
    headers?: Record<string, string>;
    onAuth?: AuthCallback;
    onProgress?: ProgressCallback;
    onMessage?: MessageCallback;
    cache?: object;
  }): Promise<PushResult>;
  pull(args: {
    fs: object;
    http: object;
    dir: string;
    url?: string;
    remote?: string;
    ref?: string;
    remoteRef?: string;
    fastForward?: boolean;
    fastForwardOnly?: boolean;
    singleBranch?: boolean;
    headers?: Record<string, string>;
    onAuth?: AuthCallback;
    onProgress?: ProgressCallback;
    onMessage?: MessageCallback;
    author?: { name: string; email: string };
    committer?: { name: string; email: string };
    cache?: object;
  }): Promise<void>;
  merge(args: {
    fs: object;
    dir: string;
    ours?: string;
    theirs: string;
    fastForward?: boolean;
    fastForwardOnly?: boolean;
    abortOnConflict?: boolean;
    message?: string;
    author?: { name: string; email: string };
    committer?: { name: string; email: string };
    dryRun?: boolean;
    cache?: object;
  }): Promise<{ oid?: string; alreadyMerged?: boolean; fastForward?: boolean }>;
  addRemote(args: {
    fs: object;
    dir: string;
    remote: string;
    url: string;
    force?: boolean;
  }): Promise<void>;
  deleteRemote(args: { fs: object; dir: string; remote: string }): Promise<void>;
  listRemotes(args: { fs: object; dir: string }): Promise<Array<{ remote: string; url: string }>>;
}

// Identity resolver shared between commit and the network family
// (pull constructs a merge commit when fast-forward is not
// possible). The shape matches commit.ts on purpose so a future
// refactor can collapse them onto one helper.
function resolveIdent(
  explicit: { name: string; email: string } | undefined,
  envName: string | undefined,
  envEmail: string | undefined,
  fallback: { name: string; email: string } | undefined,
): { name: string; email: string } | undefined {
  if (explicit?.name && explicit.email) return explicit;
  if (envName && envEmail) return { name: envName, email: envEmail };
  if (fallback?.name && fallback.email) return fallback;
  return undefined;
}

// ---------------------------------------------------------------
// fetch
// ---------------------------------------------------------------

export interface GitFetchOptions {
  dir?: string;
  /** Remote name (e.g. "origin"). Mutually exclusive with `url`. */
  remote?: string;
  /** Remote URL. Mutually exclusive with `remote`. */
  url?: string;
  /** Local ref to update. */
  ref?: string;
  /** Remote ref to read. */
  remoteRef?: string;
  depth?: number;
  singleBranch?: boolean;
  tags?: boolean;
  prune?: boolean;
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  onProgress?: ProgressCallback;
  onMessage?: MessageCallback;
}

export interface FetchWithDeps extends GitFetchOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
  http: object;
  cache?: object;
}

export interface FetchResult {
  defaultBranch: string | null;
  fetchHead: string | null;
}

export async function fetchWith(opts: FetchWithDeps): Promise<FetchResult> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.fetch({
      fs: opts.fs,
      http: opts.http,
      dir,
      url: opts.url,
      remote: opts.remote,
      ref: opts.ref,
      remoteRef: opts.remoteRef,
      depth: opts.depth,
      singleBranch: opts.singleBranch,
      tags: opts.tags,
      prune: opts.prune,
      headers: opts.headers,
      onAuth: opts.onAuth,
      onProgress: opts.onProgress,
      onMessage: opts.onMessage,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EFETCHFAIL", `git fetch failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// push
// ---------------------------------------------------------------

export interface GitPushOptions {
  dir?: string;
  remote?: string;
  url?: string;
  ref?: string;
  remoteRef?: string;
  force?: boolean;
  /** Delete the remote ref rather than push to it. */
  delete?: boolean;
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  onProgress?: ProgressCallback;
  onMessage?: MessageCallback;
}

export interface PushWithDeps extends GitPushOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
  http: object;
  cache?: object;
}

export async function pushWith(opts: PushWithDeps): Promise<PushResult> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.push({
      fs: opts.fs,
      http: opts.http,
      dir,
      url: opts.url,
      remote: opts.remote,
      ref: opts.ref,
      remoteRef: opts.remoteRef,
      force: opts.force,
      delete: opts.delete,
      headers: opts.headers,
      onAuth: opts.onAuth,
      onProgress: opts.onProgress,
      onMessage: opts.onMessage,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EPUSHFAIL", `git push failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// pull
// ---------------------------------------------------------------

export interface GitPullOptions {
  dir?: string;
  remote?: string;
  url?: string;
  ref?: string;
  remoteRef?: string;
  fastForward?: boolean;
  fastForwardOnly?: boolean;
  singleBranch?: boolean;
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  onProgress?: ProgressCallback;
  onMessage?: MessageCallback;
  /** Identity for the merge commit pull may create. */
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  /**
   * Env to read GIT_AUTHOR_* / GIT_COMMITTER_* from when pull
   * needs to materialize a merge commit. Same precedence as
   * commit: explicit -> env -> defaultIdentity.
   */
  env?: Record<string, string>;
}

export interface PullWithDeps extends GitPullOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
  http: object;
  cache?: object;
  defaultIdentity?: { name: string; email: string };
}

export async function pullWith(opts: PullWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  // pull may need to write a merge commit. If we don't have an
  // identity from anywhere, fail fast with the same error commit
  // raises so the failure mode is consistent.
  const author = resolveIdent(
    opts.author,
    opts.env?.GIT_AUTHOR_NAME,
    opts.env?.GIT_AUTHOR_EMAIL,
    opts.defaultIdentity,
  );
  const committer =
    resolveIdent(
      opts.committer,
      opts.env?.GIT_COMMITTER_NAME ?? opts.env?.GIT_AUTHOR_NAME,
      opts.env?.GIT_COMMITTER_EMAIL ?? opts.env?.GIT_AUTHOR_EMAIL,
      opts.defaultIdentity,
    ) ?? author;
  try {
    await opts.git.pull({
      fs: opts.fs,
      http: opts.http,
      dir,
      url: opts.url,
      remote: opts.remote,
      ref: opts.ref,
      remoteRef: opts.remoteRef,
      fastForward: opts.fastForward,
      fastForwardOnly: opts.fastForwardOnly,
      singleBranch: opts.singleBranch,
      headers: opts.headers,
      onAuth: opts.onAuth,
      onProgress: opts.onProgress,
      onMessage: opts.onMessage,
      author,
      committer,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    // isomorphic-git's MissingNameError fires when pull tries to
    // write a merge commit without an identity. Map it to the
    // typed surface so callers see one error class for the case.
    if (
      cause instanceof Error &&
      /Missing(Name|Email)Error|identity|cannot author/i.test(cause.message)
    ) {
      throw new MissingIdentityError({ cause });
    }
    throw new GitError("EPULLFAIL", `git pull failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// merge
// ---------------------------------------------------------------

export interface GitMergeOptions {
  dir?: string;
  /** Source branch to merge in. */
  theirs: string;
  /** Target branch. Defaults to the current branch (HEAD). */
  ours?: string;
  fastForward?: boolean;
  fastForwardOnly?: boolean;
  message?: string;
  /** Identity for the merge commit (when a fast-forward isn't possible). */
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  env?: Record<string, string>;
}

export interface MergeWithDeps extends GitMergeOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
  cache?: object;
  defaultIdentity?: { name: string; email: string };
}

export interface MergeResult {
  oid?: string;
  alreadyMerged?: boolean;
  fastForward?: boolean;
}

export async function mergeWith(opts: MergeWithDeps): Promise<MergeResult> {
  const dir = opts.dir ?? "/";
  const author = resolveIdent(
    opts.author,
    opts.env?.GIT_AUTHOR_NAME,
    opts.env?.GIT_AUTHOR_EMAIL,
    opts.defaultIdentity,
  );
  const committer =
    resolveIdent(
      opts.committer,
      opts.env?.GIT_COMMITTER_NAME ?? opts.env?.GIT_AUTHOR_NAME,
      opts.env?.GIT_COMMITTER_EMAIL ?? opts.env?.GIT_AUTHOR_EMAIL,
      opts.defaultIdentity,
    ) ?? author;
  try {
    return await opts.git.merge({
      fs: opts.fs,
      dir,
      ours: opts.ours,
      theirs: opts.theirs,
      fastForward: opts.fastForward,
      fastForwardOnly: opts.fastForwardOnly,
      message: opts.message,
      author,
      committer,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    if (
      cause instanceof Error &&
      /Missing(Name|Email)Error|identity|cannot author/i.test(cause.message)
    ) {
      throw new MissingIdentityError({ cause });
    }
    throw new GitError("EMERGEFAIL", `git merge failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// remote add / remove / list
// ---------------------------------------------------------------

export interface GitRemoteAddOptions {
  dir?: string;
  name: string;
  url: string;
  /** Overwrite an existing remote with the same name. */
  force?: boolean;
}

export interface RemoteAddWithDeps extends GitRemoteAddOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
}

export async function remoteAddWith(opts: RemoteAddWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.addRemote({
      fs: opts.fs,
      dir,
      remote: opts.name,
      url: opts.url,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EREMOTEFAIL", `git remote add failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export interface GitRemoteRemoveOptions {
  dir?: string;
  name: string;
}

export interface RemoteRemoveWithDeps extends GitRemoteRemoveOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
}

export async function remoteRemoveWith(opts: RemoteRemoveWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.deleteRemote({ fs: opts.fs, dir, remote: opts.name });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EREMOTEFAIL", `git remote remove failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export interface GitRemoteListOptions {
  dir?: string;
}

export interface RemoteListWithDeps extends GitRemoteListOptions {
  git: IsomorphicGitNetworkClient;
  fs: object;
}

export interface RemoteView {
  name: string;
  url: string;
}

export async function remoteListWith(opts: RemoteListWithDeps): Promise<RemoteView[]> {
  const dir = opts.dir ?? "/";
  try {
    const remotes = await opts.git.listRemotes({ fs: opts.fs, dir });
    return remotes.map((r) => ({ name: r.remote, url: r.url }));
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EREMOTEFAIL", `git remote failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
