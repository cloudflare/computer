// Public surface of @cloudflare/computer/git.
//
// `createGitClient()` is the one entry point. It returns a
// WorkspaceOptions.git factory; the factory binds a workspace
// handle once and returns a `GitClient` whose methods don't repeat
// the workspace argument. Today the typed surface is
// `clone` and `diff`; `cli` is the argv-driven door into the same
// implementations, used by the worker-backend's `git` custom
// command in the shell isolate.
//
// Internally each method lazy-loads its heavy deps
// (`isomorphic-git`, the http transport, and `diff` for patches)
// and delegates to `cloneWith` / `diffWith`. The
// loaders are memoised on the client so the dynamic imports fire
// once across the lifetime of the client — without that, the CLI
// would multiply the cost (re-importing isomorphic-git on every
// dispatch) and even the existing JS surface re-imported per call.
//
// `cloneWith` and `diffWith` are still exported for callers that
// bring their own FsClient — tests, custom adapters, running
// against node:fs directly — but the workspace-bound path is the
// only one most consumers need.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

import { type IsomorphicGitFSClient, workspaceIsomorphicGitClient } from "./adapter.js";
import { type GitCliInput, type GitCliResult, runGitCli } from "./cli.js";
import { cloneWith, type GitCloneOptions, type IsomorphicGitClient } from "./clone.js";
import {
  type CommitResult,
  commitWith,
  type GitCommitOptions,
  type IsomorphicGitCommitClient,
} from "./commit.js";
import {
  type CreatePatchFn,
  type DiffSummaryEntry,
  diffSummaryWith,
  diffWith,
  type GitDiffOptions,
  type IsomorphicGitDiffClient,
  type ReadFileFn,
} from "./diff.js";
import { type GitInitOptions, type IsomorphicGitInitClient, initWith } from "./init.js";
import {
  type FetchResult,
  fetchWith,
  type GitFetchOptions,
  type GitMergeOptions,
  type GitPullOptions,
  type GitPushOptions,
  type GitRemoteAddOptions,
  type GitRemoteListOptions,
  type GitRemoteRemoveOptions,
  type IsomorphicGitNetworkClient,
  type MergeResult,
  mergeWith,
  type PushResult,
  pullWith,
  pushWith,
  type RemoteView,
  remoteAddWith,
  remoteListWith,
  remoteRemoveWith,
} from "./network.js";
import {
  type CatFileResult,
  catFileWith,
  configGetWith,
  configSetWith,
  type GitCatFileOptions,
  type GitConfigGetOptions,
  type GitConfigSetOptions,
  type GitHashObjectOptions,
  type GitUpdateRefOptions,
  hashObjectWith,
  type IsomorphicGitPlumbingClient,
  updateRefWith,
} from "./plumbing.js";
import {
  type CommitView,
  currentBranchWith,
  type GitCurrentBranchOptions,
  type GitLogOptions,
  type GitLsFilesOptions,
  type GitLsTreeOptions,
  type GitRepoRootOptions,
  type GitRevParseOptions,
  type GitShowOptions,
  type IsomorphicGitReadsClient,
  logWith,
  lsFilesWith,
  lsTreeWith,
  repoRootWith,
  revParseWith,
  showWith,
  type TreeEntryView,
} from "./reads.js";
import {
  branchDeleteWith,
  branchListWith,
  branchWith,
  checkoutWith,
  type GitBranchDeleteOptions,
  type GitBranchListOptions,
  type GitBranchOptions,
  type GitCheckoutOptions,
  type GitTagDeleteOptions,
  type GitTagListOptions,
  type GitTagOptions,
  type IsomorphicGitRefsClient,
  tagDeleteWith,
  tagListWith,
  tagWith,
} from "./refs.js";
import {
  addWith,
  type GitAddOptions,
  type GitRmOptions,
  type IsomorphicGitAddClient,
  type IsomorphicGitRmClient,
  rmWith,
} from "./staging.js";
import {
  type GitStatusOptions,
  type IsomorphicGitStatusClient,
  type StatusEntry,
  statusWith,
} from "./status.js";
import {
  type BaseWorktreeOptions,
  type CleanOptions,
  cleanWith,
  type IsomorphicGitCleanClient,
  type IsomorphicGitResetClient,
  type IsomorphicGitStashClient,
  type ResetOptions,
  resetWith,
  type StashPopOptions,
  type StashPushOptions,
  stashListWith,
  stashPopWith,
  stashPushWith,
} from "./worktree.js";

export type { GitCliInput, GitCliResult } from "./cli.js";
export type { GitCloneOptions, MessageCallback, ProgressCallback } from "./clone.js";
export type { CommitResult, GitCommitOptions } from "./commit.js";
export type { DiffSummaryEntry, GitDiffOptions, StatusRow } from "./diff.js";
export {
  AlreadyInitializedError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  PathOutsideRepoError,
  PathspecNotFoundError,
} from "./errors.js";
export type { GitInitOptions } from "./init.js";
export type {
  AuthCallback,
  FetchResult,
  GitAuth,
  GitFetchOptions,
  GitMergeOptions,
  GitPullOptions,
  GitPushOptions,
  GitRemoteAddOptions,
  GitRemoteListOptions,
  GitRemoteRemoveOptions,
  MergeResult,
  PushResult,
  RefUpdateStatus,
  RemoteView,
} from "./network.js";
export type {
  CatFileResult,
  GitCatFileOptions,
  GitConfigGetOptions,
  GitConfigSetOptions,
  GitHashObjectOptions,
  GitUpdateRefOptions,
} from "./plumbing.js";
export type {
  CommitView,
  GitCurrentBranchOptions,
  GitLogOptions,
  GitLsFilesOptions,
  GitLsTreeOptions,
  GitRepoRootOptions,
  GitRevParseOptions,
  GitShowOptions,
  TreeEntryView,
} from "./reads.js";
export type {
  GitBranchDeleteOptions,
  GitBranchListOptions,
  GitBranchOptions,
  GitCheckoutOptions,
  GitTagDeleteOptions,
  GitTagListOptions,
  GitTagOptions,
} from "./refs.js";
export type { GitAddOptions, GitRmOptions } from "./staging.js";
export type { GitStatusOptions, StatusEntry } from "./status.js";
export type {
  BaseWorktreeOptions,
  CleanOptions,
  ResetOptions,
  StashPopOptions,
  StashPushOptions,
} from "./worktree.js";

/** Duck-typed workspace handle. Only `.provider()` is required. */
export interface WorkspaceLike {
  provider(): SQLiteWorkspaceProvider;
}

/**
 * Identity used as the author/committer fallback when a commit-
 * producing subcommand (`commit`, `pull`, `merge`) isn't passed
 * one explicitly. The precedence is explicit options →
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env → this fallback. If
 * none of the three yields a name and email,
 * `MissingIdentityError` fires.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Methods returned by `createGitClient`. */
export interface GitClient {
  /** Shallow-clone a remote into the bound workspace. */
  clone(options: GitCloneOptions): Promise<void>;
  /** Unified diff between a ref (default HEAD) and the working tree. */
  diff(options?: GitDiffOptions): Promise<string>;
  /** Per-file change summary backing `--stat` / `--name-only` / `--name-status`. */
  diffSummary(options?: GitDiffOptions): Promise<DiffSummaryEntry[]>;
  /** Initialise a new repository in the bound workspace. */
  init(options?: GitInitOptions): Promise<void>;
  /** Describe the working-tree / index / HEAD delta. */
  status(options?: GitStatusOptions): Promise<StatusEntry[]>;
  /** Stage paths into the index. */
  add(options: GitAddOptions): Promise<void>;
  /** Unstage paths from the index. */
  rm(options: GitRmOptions): Promise<void>;
  /** Write the current index to a new commit on HEAD. */
  commit(options: GitCommitOptions): Promise<CommitResult>;
  /** Walk commits from `ref` (default HEAD) backwards through history. */
  log(options?: GitLogOptions): Promise<CommitView[]>;
  /** Read a single commit by ref or oid. */
  show(options: GitShowOptions): Promise<CommitView>;
  /** Resolve a ref to its SHA-1 oid. */
  revParse(options: GitRevParseOptions): Promise<string>;
  /** Find the repository root by walking up from `dir`. */
  repoRoot(options?: GitRepoRootOptions): Promise<string>;
  /** Current branch name, or undefined on detached HEAD. */
  currentBranch(options?: GitCurrentBranchOptions): Promise<string | undefined>;
  /** List files in the index (or at a given ref). */
  lsFiles(options?: GitLsFilesOptions): Promise<string[]>;
  /** List one level of a tree (or sub-tree). */
  lsTree(options: GitLsTreeOptions): Promise<TreeEntryView[]>;
  /** Create a branch. */
  branch(options: GitBranchOptions): Promise<void>;
  /** Delete a branch. */
  branchDelete(options: GitBranchDeleteOptions): Promise<void>;
  /** List local branches. */
  branchList(options?: GitBranchListOptions): Promise<string[]>;
  /** Create a lightweight tag. */
  tag(options: GitTagOptions): Promise<void>;
  /** Delete a tag. */
  tagDelete(options: GitTagDeleteOptions): Promise<void>;
  /** List tags. */
  tagList(options?: GitTagListOptions): Promise<string[]>;
  /** Move HEAD to a ref, or update working-tree paths to a ref. */
  checkout(options: GitCheckoutOptions): Promise<void>;
  /** Fetch refs from a remote. */
  fetch(options?: GitFetchOptions): Promise<FetchResult>;
  /** Push local refs to a remote. */
  push(options?: GitPushOptions): Promise<PushResult>;
  /** Fetch and merge in one step. */
  pull(options?: GitPullOptions): Promise<void>;
  /** Merge a ref into the current branch (or `ours`). */
  merge(options: GitMergeOptions): Promise<MergeResult>;
  /** Add a named remote pointing at a URL. */
  remoteAdd(options: GitRemoteAddOptions): Promise<void>;
  /** Remove a named remote. */
  remoteRemove(options: GitRemoteRemoveOptions): Promise<void>;
  /** List configured remotes. */
  remoteList(options?: GitRemoteListOptions): Promise<RemoteView[]>;
  /** Hash bytes as a blob; optionally write into the object store. */
  hashObject(options: GitHashObjectOptions): Promise<string>;
  /** Read raw bytes for an object by oid. */
  catFile(options: GitCatFileOptions): Promise<CatFileResult>;
  /** Write a ref directly. */
  updateRef(options: GitUpdateRefOptions): Promise<void>;
  /** Read a single config key. */
  configGet(options: GitConfigGetOptions): Promise<string | string[] | undefined>;
  /** Write a single config key. */
  configSet(options: GitConfigSetOptions): Promise<void>;
  /** Stash tracked working-tree changes. */
  stashPush(options?: StashPushOptions): Promise<void>;
  /** List stash entries, newest first. */
  stashList(options?: BaseWorktreeOptions): Promise<string[]>;
  /** Restore the latest stash entry. */
  stashPop(options?: StashPopOptions): Promise<void>;
  /** Unstage paths or hard-reset tracked files to a ref. */
  reset(options?: ResetOptions): Promise<void>;
  /** Remove untracked files (and directories with `directories`). */
  clean(options?: CleanOptions): Promise<string[]>;
  /**
   * Argv-driven entry point. The worker-backend's `git` custom
   * command dispatches through this; in-process callers can use
   * it too when they want CLI-shaped output.
   */
  cli(input: GitCliInput): Promise<GitCliResult>;
}

export interface WorkspaceGitClientOptions {
  /** Workspace whose provider backs the git operations. */
  ws: WorkspaceLike;
  /**
   * Default identity used by commit-producing subcommands
   * (`commit`, `pull`, `merge`) when the caller hasn't passed
   * one explicitly and the relevant `GIT_AUTHOR_*` /
   * `GIT_COMMITTER_*` env vars are absent.
   */
  defaultIdentity?: GitIdentity;
}

export interface CreateGitClientOptions {
  /**
   * Test seam for substituting the @platformatic/vfs adapter.
   * Production callers do not pass this.
   */
  adapter?: (provider: SQLiteWorkspaceProvider) => Promise<IsomorphicGitFSClient>;
}

export type GitClientFactory = (options: WorkspaceGitClientOptions) => GitClient;

/**
 * Build a git client bound to a workspace.
 *
 * The FsClient is constructed lazily on first use and reused
 * across subsequent calls — `@platformatic/vfs.create()` is cheap
 * but not free, and the workspace provider is stable for the
 * lifetime of the client.
 *
 * An isomorphic-git pack/index cache is also created per client
 * and threaded into every isogit call. Without this, each
 * `readBlob` / `statusMatrix` / `walk` re-parses the packfile
 * from the SQLite-backed VFS — fine for tiny repos, catastrophic
 * for anything with a real history (the difference between a
 * sub-second `diff` and one that hangs for minutes).
 *
 * The dynamic imports for `isomorphic-git`, its HTTP transport,
 * and the `diff` package are memoised on the client too. The
 * first method call pays the cost; every subsequent call (typed
 * or CLI) reuses the resolved modules.
 */
export function createGitClient({
  adapter = workspaceIsomorphicGitClient,
}: CreateGitClientOptions = {}): GitClientFactory {
  return function createWorkspaceGitClient({
    ws,
    defaultIdentity,
  }: WorkspaceGitClientOptions): GitClient {
    let fsPromise: Promise<IsomorphicGitFSClient> | undefined;
    const fs = () => {
      if (!fsPromise) fsPromise = adapter(ws.provider());
      return fsPromise;
    };
    const cache: Record<string, unknown> = {};

    // Memoised module loaders. Each holds the promise returned by
    // the dynamic import so concurrent first-use callers share one
    // import pass, and subsequent callers reuse the resolved module
    // synchronously through the cached promise.
    let gitPromise: Promise<unknown> | undefined;
    let httpPromise: Promise<object> | undefined;
    let createPatchPromise: Promise<CreatePatchFn> | undefined;
    const loadGit = <T>(): Promise<T> => {
      if (!gitPromise) gitPromise = loadIsomorphicGit();
      return gitPromise as Promise<T>;
    };
    const loadHttp = (): Promise<object> => {
      if (!httpPromise) httpPromise = loadDefaultHTTP();
      return httpPromise;
    };
    const loadDiffPatch = (): Promise<CreatePatchFn> => {
      if (!createPatchPromise) createPatchPromise = loadCreatePatch();
      return createPatchPromise;
    };

    const client: GitClient = {
      async clone(options) {
        await cloneWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitClient>(),
          http: await loadHttp(),
          cache,
        });
      },
      async diff(options = {}) {
        const f = await fs();
        return diffWith({
          ...options,
          fs: f,
          git: await loadGit<IsomorphicGitDiffClient>(),
          createPatch: await loadDiffPatch(),
          readFile: readFileFrom(f),
          cache,
        });
      },
      async diffSummary(options = {}) {
        const f = await fs();
        return diffSummaryWith({
          ...options,
          fs: f,
          git: await loadGit<IsomorphicGitDiffClient>(),
          createPatch: await loadDiffPatch(),
          readFile: readFileFrom(f),
          cache,
        });
      },
      async init(options = {}) {
        await initWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitInitClient>(),
        });
      },
      async status(options = {}) {
        return statusWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitStatusClient>(),
          cache,
        });
      },
      async add(options) {
        await addWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitAddClient>(),
          cache,
        });
      },
      async rm(options) {
        await rmWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRmClient>(),
          cache,
        });
      },
      async commit(options) {
        return commitWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitCommitClient>(),
          cache,
          defaultIdentity,
        });
      },
      async log(options = {}) {
        return logWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
          cache,
        });
      },
      async show(options) {
        return showWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
          cache,
        });
      },
      async revParse(options) {
        return revParseWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
          cache,
        });
      },
      async repoRoot(options = {}) {
        return repoRootWith({ ...options, fs: await fs() });
      },
      async currentBranch(options = {}) {
        return currentBranchWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
        });
      },
      async lsFiles(options = {}) {
        return lsFilesWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
          cache,
        });
      },
      async lsTree(options) {
        return lsTreeWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitReadsClient>(),
          cache,
        });
      },
      async branch(options) {
        return branchWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async branchDelete(options) {
        return branchDeleteWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async branchList(options = {}) {
        return branchListWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async tag(options) {
        return tagWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async tagDelete(options) {
        return tagDeleteWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async tagList(options = {}) {
        return tagListWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
        });
      },
      async checkout(options) {
        return checkoutWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitRefsClient>(),
          cache,
        });
      },
      async fetch(options = {}) {
        return fetchWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
          http: await loadHttp(),
          cache,
        });
      },
      async push(options = {}) {
        return pushWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
          http: await loadHttp(),
          cache,
        });
      },
      async pull(options = {}) {
        return pullWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
          http: await loadHttp(),
          cache,
          defaultIdentity,
        });
      },
      async merge(options) {
        return mergeWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
          cache,
          defaultIdentity,
        });
      },
      async remoteAdd(options) {
        return remoteAddWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
        });
      },
      async remoteRemove(options) {
        return remoteRemoveWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
        });
      },
      async remoteList(options = {}) {
        return remoteListWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitNetworkClient>(),
        });
      },
      async hashObject(options) {
        return hashObjectWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitPlumbingClient>(),
        });
      },
      async catFile(options) {
        return catFileWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitPlumbingClient>(),
          cache,
        });
      },
      async updateRef(options) {
        return updateRefWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitPlumbingClient>(),
        });
      },
      async configGet(options) {
        return configGetWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitPlumbingClient>(),
        });
      },
      async configSet(options) {
        return configSetWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitPlumbingClient>(),
        });
      },
      async stashPush(options = {}) {
        return stashPushWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitStashClient>(),
        });
      },
      async stashList(options = {}) {
        return stashListWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitStashClient>(),
        });
      },
      async stashPop(options = {}) {
        return stashPopWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitStashClient>(),
        });
      },
      async reset(options = {}) {
        return resetWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitResetClient>(),
          cache,
        });
      },
      async clean(options = {}) {
        return cleanWith({
          ...options,
          fs: await fs(),
          git: await loadGit<IsomorphicGitCleanClient>(),
          cache,
        });
      },
      async cli(input) {
        return runGitCli(client, input, { defaultIdentity });
      },
    };
    return client;
  };
}

// isomorphic-git ships both named exports and a default export
// (CJS interop). Callers pull the subset they need via the generic.
async function loadIsomorphicGit<T = unknown>(): Promise<T> {
  try {
    const mod = await import("isomorphic-git");
    return (mod.default ?? mod) as unknown as T;
  } catch (cause) {
    throw new Error(
      "Failed to load @cloudflare/computer/git's bundled isomorphic-git implementation.",
      { cause },
    );
  }
}

async function loadDefaultHTTP(): Promise<object> {
  try {
    const mod = await import("isomorphic-git/http/web");
    return mod.default;
  } catch (cause) {
    throw new Error("Failed to load @cloudflare/computer/git's bundled HTTP transport.", { cause });
  }
}

async function loadCreatePatch(): Promise<CreatePatchFn> {
  try {
    const mod = await import("diff");
    return mod.createPatch;
  } catch (cause) {
    throw new Error("Failed to load @cloudflare/computer/git's bundled diff implementation.", {
      cause,
    });
  }
}

function readFileFrom(fs: IsomorphicGitFSClient): ReadFileFn {
  // `fs.promises` is typed as `object` on the public surface; the
  // underlying @platformatic/vfs handle exposes `readFile`. Narrow
  // locally rather than widening the exported type.
  const promises = fs.promises as { readFile: ReadFileFn };
  return (path) => promises.readFile(path);
}
