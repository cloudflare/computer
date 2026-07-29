// `git init` — create a `.git` directory in the working tree.
//
// `initWith` is the testable core: it takes a pre-built
// IsomorphicGitInitClient. The public `init()` in ./index.ts
// resolves it from a dynamic import of `isomorphic-git`.

import { AlreadyInitializedError, GitError } from "./errors.js";

/** Subset of `isomorphic-git`'s API used for `init`. */
export interface IsomorphicGitInitClient {
  init(args: { fs: object; dir: string; bare?: boolean; defaultBranch?: string }): Promise<void>;
}

/**
 * Read-side seam: only used to detect "already initialised". A
 * minimal `stat` that resolves on a path is enough. The `fs`
 * client we already use elsewhere satisfies this shape.
 */
export interface InitFsProbe {
  promises: {
    stat(path: string): Promise<unknown>;
  };
}

export interface GitInitOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Default branch name. Defaults to `main`. */
  defaultBranch?: string;
  /**
   * Create a bare repository (no working tree). Default `false`.
   * Bare repositories live in `dir` directly rather than under
   * `dir/.git`.
   */
  bare?: boolean;
}

export interface InitWithDeps extends GitInitOptions {
  git: IsomorphicGitInitClient;
  fs: InitFsProbe | object;
}

export async function initWith(opts: InitWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  const defaultBranch = opts.defaultBranch ?? "main";
  const bare = opts.bare ?? false;

  // Detect "already a repo" up front so we can throw the typed
  // error. isomorphic-git's `init` is documented as idempotent,
  // so without this probe a second call would silently succeed.
  if (!bare) {
    const probe = (opts.fs as InitFsProbe).promises?.stat;
    if (typeof probe === "function") {
      try {
        await probe(joinPath(dir, ".git"));
        throw new AlreadyInitializedError(dir);
      } catch (cause) {
        if (cause instanceof AlreadyInitializedError) throw cause;
        // anything else — including the expected ENOENT —
        // means "no repo here; safe to init".
      }
    }
  }

  try {
    await opts.git.init({ fs: opts.fs, dir, bare, defaultBranch });
  } catch (cause) {
    throw new GitError("EINITFAIL", `git init failed: ${errorMessage(cause)}`, { cause });
  }
}

function joinPath(base: string, segment: string): string {
  if (base.endsWith("/")) return `${base}${segment}`;
  return `${base}/${segment}`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
