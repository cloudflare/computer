// `git commit` — write the index to a new commit on HEAD.
//
// Identity resolution lives here because every commit needs an
// author / committer pair. The precedence is documented:
//
//   1. options.author / options.committer (call-site explicit)
//   2. options.env's GIT_AUTHOR_* / GIT_COMMITTER_* if present
//   3. local repo config: user.name / user.email
//   4. options.defaultIdentity (the GitClient-level default)
//
// If none of the four yield a name+email, throw
// MissingIdentityError. The CLI dispatcher maps that to exit 128
// with a stderr line matching real git's wording.

import {
  GitError,
  isNotARepositoryCause,
  MissingIdentityError,
  NotARepositoryError,
} from "./errors.js";

/** Identity matched against isomorphic-git's author/committer arg shape. */
export interface GitCommitIdentity {
  name: string;
  email: string;
  /** Seconds since epoch. Optional; isomorphic-git defaults to "now". */
  timestamp?: number;
  /** Minutes east of UTC. Optional. */
  timezoneOffset?: number;
}

/** Subset of `isomorphic-git`'s API used for `commit`. */
export interface IsomorphicGitCommitClient {
  commit(args: {
    fs: object;
    dir: string;
    message: string;
    author?: GitCommitIdentity;
    committer?: GitCommitIdentity;
    amend?: boolean;
    cache?: object;
  }): Promise<string>;
  /** Read a single config value; used to resolve identity. */
  getConfig(args: { fs: object; dir: string; path: string }): Promise<unknown>;
}

export interface GitCommitOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Commit message. Required. */
  message: string;
  /** Override the author pulled from env / defaultIdentity. */
  author?: { name: string; email: string };
  /** Override the committer. Defaults to the resolved author. */
  committer?: { name: string; email: string };
  /** Amend HEAD rather than creating a new commit. Default `false`. */
  amend?: boolean;
  /**
   * Env to read GIT_AUTHOR_* / GIT_COMMITTER_* from. Surfaced as
   * an option (not pulled from `process.env`) so the package
   * stays portable across runtimes.
   */
  env?: Record<string, string>;
}

export interface CommitWithDeps extends GitCommitOptions {
  git: IsomorphicGitCommitClient;
  fs: object;
  cache?: object;
  /** Fallback identity from the GitClient. */
  defaultIdentity?: { name: string; email: string };
}

export interface CommitResult {
  /** SHA-1 of the new (or amended) commit. */
  oid: string;
}

export async function commitWith(opts: CommitWithDeps): Promise<CommitResult> {
  const dir = opts.dir ?? "/";
  if (!opts.message || opts.message.trim().length === 0) {
    throw new GitError("EMSG", "commit message is required");
  }

  // Read the local config identity once; it sits between env and
  // the GitClient default in precedence. A missing key resolves
  // to undefined, so the fallback chain skips it cleanly.
  const configName = await readConfigString(opts, dir, "user.name");
  const configEmail = await readConfigString(opts, dir, "user.email");
  const configIdent =
    configName && configEmail ? { name: configName, email: configEmail } : undefined;

  const author = resolveIdent(
    opts.author,
    opts.env?.GIT_AUTHOR_NAME,
    opts.env?.GIT_AUTHOR_EMAIL,
    configIdent,
    opts.defaultIdentity,
  );
  if (!author) throw new MissingIdentityError();
  const committer =
    resolveIdent(
      opts.committer,
      opts.env?.GIT_COMMITTER_NAME ?? opts.env?.GIT_AUTHOR_NAME,
      opts.env?.GIT_COMMITTER_EMAIL ?? opts.env?.GIT_AUTHOR_EMAIL,
      configIdent,
      opts.defaultIdentity,
    ) ?? author;

  let oid: string;
  try {
    oid = await opts.git.commit({
      fs: opts.fs,
      dir,
      message: opts.message,
      author,
      committer,
      amend: opts.amend,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECOMMITFAIL", `git commit failed: ${errorMessage(cause)}`, { cause });
  }
  return { oid };
}

function resolveIdent(
  explicit: { name: string; email: string } | undefined,
  envName: string | undefined,
  envEmail: string | undefined,
  config: { name: string; email: string } | undefined,
  fallback: { name: string; email: string } | undefined,
): { name: string; email: string } | undefined {
  if (explicit?.name && explicit.email) return explicit;
  if (envName && envEmail) return { name: envName, email: envEmail };
  if (config?.name && config.email) return config;
  if (fallback?.name && fallback.email) return fallback;
  return undefined;
}

async function readConfigString(
  opts: CommitWithDeps,
  dir: string,
  path: string,
): Promise<string | undefined> {
  try {
    const value = await opts.git.getConfig({ fs: opts.fs, dir, path });
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    // A missing config file or unreadable key is not an error
    // here; identity resolution just falls through to the next
    // source.
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
