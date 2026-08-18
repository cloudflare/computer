// Typed error hierarchy for the artifacts surface.

export const ARTIFACTS_NOT_CONFIGURED_MESSAGE = "Workspace Artifacts binding is not configured";

// The CLI dispatcher in `cli.ts` maps each class to a
// deterministic exit code and a stderr line so a shell consumer
// can match on the text. The hierarchy is deliberately narrow:
// only the failure modes a caller can act on get their own class.
// Anything else surfaces as a generic `ArtifactError` carrying the
// underlying cause.

/**
 * Base class for every artifacts error. The `code` field is the
 * contract: CLI dispatchers and external callers branch on it.
 */
export class ArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "ArtifactError";
  }
}

/**
 * Raised when a repo name is empty, contains a path separator, or
 * is otherwise unusable as the trailing segment of a scoped name.
 */
export class InvalidRepoNameError extends ArtifactError {
  constructor(name: string, reason: string, options?: { cause?: unknown }) {
    super("EINVALIDNAME", `invalid repository name '${name}': ${reason}`, options);
    this.name = "InvalidRepoNameError";
  }
}

/**
 * Raised when a session id is empty or contains a path separator.
 * A session id becomes the leading segment of every scoped name,
 * so it has the same shape constraints as a repo name.
 *
 * An empty id is an error rather than a way to ask for a client
 * without a session. That is what omitting the id does, and an id
 * that came out empty by accident should not silently widen a
 * client from one session to the whole namespace.
 */
export class InvalidSessionIdError extends ArtifactError {
  constructor(sessionId: string, reason: string, options?: { cause?: unknown }) {
    super("EINVALIDSESSION", `invalid session id '${sessionId}': ${reason}`, options);
    this.name = "InvalidSessionIdError";
  }
}

/**
 * Raised when a repo lookup misses or a token id can't be found
 * within a repo's token list.
 */
export class NotFoundError extends ArtifactError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ENOTFOUND", message, options);
    this.name = "NotFoundError";
  }
}
