// Typed error hierarchy for the workspace git surface.
//
// Each public method on `GitClient` documents which of these it
// can throw. The CLI dispatcher in `cli.ts` maps each error class
// to a deterministic exit code and a stderr line shaped like real
// git's, so a shell consumer matching on text (`grep -q "not a
// git repository"`) sees the message they'd expect.
//
// The hierarchy is deliberately narrow. We don't try to surface
// every error isomorphic-git can throw — only the ones that
// represent expected, documented failure modes a caller can act
// on. Anything else surfaces as a generic `GitError` carrying
// the underlying cause, which the CLI prints with the usual
// `git: <message>\n` framing.

/**
 * Base class for every workspace-git error. The `code` field is
 * the contract: CLI dispatchers and external callers branch on
 * it. Subclass instances also pin `name` to a stable string so
 * `Error.prototype.toString()` reads sensibly.
 */
export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "GitError";
  }
}

/**
 * Raised when an operation needs a git repository at `dir` and
 * none exists. CLI exit code: 128.
 */
export class NotARepositoryError extends GitError {
  constructor(dir: string, options?: { cause?: unknown }) {
    super("ENOTAREPO", `not a git repository: ${dir}`, options);
    this.name = "NotARepositoryError";
  }
}

/**
 * Raised when an operation needs a working repository at `dir`
 * and `dir` already contains a `.git` directory. CLI exit code:
 * 128.
 */
export class AlreadyInitializedError extends GitError {
  constructor(dir: string, options?: { cause?: unknown }) {
    super("EALREADYINIT", `git repository already exists at ${dir}`, options);
    this.name = "AlreadyInitializedError";
  }
}

/**
 * Raised when a commit-producing operation can't resolve an
 * author / committer identity from any source (call-site
 * options, `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars, or the
 * client's `defaultIdentity`). CLI exit code: 128.
 */
export class MissingIdentityError extends GitError {
  constructor(options?: { cause?: unknown }) {
    super(
      "EIDENTITY",
      "author identity unknown. Pass author, set GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL, or configure defaultIdentity on the GitClient.",
      options,
    );
    this.name = "MissingIdentityError";
  }
}

/**
 * Raised when a path argument falls outside the working tree
 * root. CLI exit code: 128.
 */
export class PathOutsideRepoError extends GitError {
  constructor(path: string, dir: string, options?: { cause?: unknown }) {
    super("EPATHOUTSIDE", `path '${path}' is outside the repository at ${dir}`, options);
    this.name = "PathOutsideRepoError";
  }
}

/**
 * Raised when an op operates on paths and none of them resolve.
 * Real git exits 128 with `pathspec '<x>' did not match any files`;
 * we do the same.
 */
export class PathspecNotFoundError extends GitError {
  constructor(pathspec: string, options?: { cause?: unknown }) {
    super("EPATHSPEC", `pathspec '${pathspec}' did not match any files`, options);
    this.name = "PathspecNotFoundError";
  }
}

/**
 * Heuristic for "no .git in this directory". isomorphic-git
 * throws a `NotFoundError` with `.caller === "readObject"` (or
 * similar) when the gitdir is missing; we surface that as a
 * `NotARepositoryError` so callers don't have to know the
 * internal shape.
 */
export function isNotARepositoryCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  // isomorphic-git's NotFoundError shows up in three flavours
  // depending on how deep we got before the failure:
  //
  //   - VFS-level ENOENT on the gitdir itself: message contains
  //     `.git` plus an ENOENT-shaped phrase.
  //   - HEAD lookup before any other read: a NotFoundError whose
  //     message reads "Could not find HEAD." / "Could not find
  //     refs/heads/main."
  //   - Object-store lookup: a NotFoundError on a SHA or pack.
  //
  // For the not-a-repo signal we want the first two: missing
  // .git or missing HEAD. Object-store misses are a different
  // failure mode and should not collapse to NotARepositoryError.
  const code = (cause as { code?: unknown }).code;
  const name = cause.name;
  const message = cause.message;
  if (
    (name === "NotFoundError" || code === "NotFoundError") &&
    /Could not find (HEAD|refs\/)/.test(message)
  ) {
    return true;
  }
  const m = message.toLowerCase();
  return (
    m.includes(".git") &&
    (m.includes("enoent") || m.includes("could not find") || m.includes("does not exist"))
  );
}
