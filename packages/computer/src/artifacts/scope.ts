// Session scoping for artifact repository names.
//
// Every name a caller passes to the facade is local — `starter`,
// `react-mirror`. The facade prefixes the session id to form the
// fully-qualified name the binding stores: `${sessionId}__${name}`.
// Reads run the inverse: a scoped name is stripped back to its
// local form, and any name that doesn't belong to the session is
// filtered out.
//
// Artifacts repository names may contain letters, digits, `.`, `_`,
// and `-`, but not `/`. The scope separator is therefore a double
// underscore. Both the session id and the local name are forbidden
// from containing that separator, so the split is unambiguous.

import { InvalidRepoNameError, InvalidSessionIdError } from "./errors.js";

export const SCOPE_SEPARATOR = "__";

const VALID_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_REPO_NAME_DESCRIPTION =
  "must start with a letter or digit and contain only letters, digits, '.', '_', and '-'";

/** Validate a session id and return it, or throw. */
export function assertSessionId(sessionId: string): string {
  if (sessionId.length === 0) {
    throw new InvalidSessionIdError(sessionId, "must not be empty");
  }
  if (!VALID_REPO_NAME.test(sessionId)) {
    throw new InvalidSessionIdError(sessionId, VALID_REPO_NAME_DESCRIPTION);
  }
  if (sessionId.includes(SCOPE_SEPARATOR)) {
    throw new InvalidSessionIdError(sessionId, `must not contain '${SCOPE_SEPARATOR}'`);
  }
  return sessionId;
}

/** Validate a local repo name and return it, or throw. */
export function assertLocalName(name: string): string {
  if (name.length === 0) {
    throw new InvalidRepoNameError(name, "must not be empty");
  }
  if (!VALID_REPO_NAME.test(name)) {
    throw new InvalidRepoNameError(name, VALID_REPO_NAME_DESCRIPTION);
  }
  if (name.includes(SCOPE_SEPARATOR)) {
    throw new InvalidRepoNameError(name, `must not contain '${SCOPE_SEPARATOR}'`);
  }
  return name;
}

/** Build the fully-qualified name the binding stores. */
export function scopedName(sessionId: string, name: string): string {
  return `${assertSessionId(sessionId)}${SCOPE_SEPARATOR}${assertLocalName(name)}`;
}

/** The prefix that every scoped name for a session begins with. */
export function scopePrefix(sessionId: string): string {
  return `${assertSessionId(sessionId)}${SCOPE_SEPARATOR}`;
}

/**
 * Strip the session prefix from a scoped name. Returns undefined
 * when the name does not belong to the session, so a caller can
 * filter a mixed listing in one pass.
 */
export function unscopedName(sessionId: string, scoped: string): string | undefined {
  const prefix = scopePrefix(sessionId);
  if (!scoped.startsWith(prefix)) return undefined;
  const local = scoped.slice(prefix.length);
  // A scoped name with a nested separator (`sess__a__b`) does not
  // round-trip through `scopedName`, so it can't have been minted
  // by this facade. Treat it as foreign.
  if (local.length === 0 || local.includes(SCOPE_SEPARATOR)) return undefined;
  return local;
}
