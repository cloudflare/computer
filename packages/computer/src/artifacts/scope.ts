// Session scoping for artifact repository names.
//
// Scoping is optional, so these helpers take a session id that may
// be undefined and behave in one of two modes.
//
// With a session id, every name a caller passes to the wrapper is
// local — `starter`, `react-mirror`. The wrapper prefixes the session
// id to form the fully-qualified name the binding stores:
// `${sessionId}__${name}`. Reads run the inverse: a scoped name is
// stripped back to its local form, and any name that doesn't belong
// to the session is filtered out.
//
// Without one, names pass through untouched in both directions and
// nothing is filtered, so the caller addresses every repository in
// the namespace — including the ones scoped sessions minted. Those
// carry the separator in their stored name, so an unscoped name is
// held only to the charset the binding itself enforces.
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

/**
 * Resolve an optional session id to the scope the wrapper runs in:
 * a validated session id, or undefined for an unscoped client that
 * sees the whole namespace.
 *
 * Only an omitted (or explicitly null) id means unscoped. An empty
 * string is a validation error, not a synonym for absence: an id
 * that came out empty by accident would otherwise widen a client
 * from one session to every session in the namespace in silence.
 */
export function normalizeSessionId(sessionId: string | null | undefined): string | undefined {
  if (sessionId === undefined || sessionId === null) return undefined;
  return assertSessionId(sessionId);
}

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

/**
 * Validate a name for an unscoped client and return it, or throw.
 * The only rule is the binding's own charset: such a client works
 * in the namespace's stored names, and those include the
 * separator-bearing names scoped sessions mint.
 */
export function assertRepoName(name: string): string {
  if (name.length === 0) {
    throw new InvalidRepoNameError(name, "must not be empty");
  }
  if (!VALID_REPO_NAME.test(name)) {
    throw new InvalidRepoNameError(name, VALID_REPO_NAME_DESCRIPTION);
  }
  return name;
}

/**
 * Build the name the binding stores. Under a session that is the
 * fully-qualified `${sessionId}__${name}`; without one it is the
 * caller's name unchanged.
 */
export function scopedName(sessionId: string | undefined, name: string): string {
  if (sessionId === undefined) return assertRepoName(name);
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
 *
 * Without a session id there is no prefix to strip and no such
 * thing as a foreign name, so every name comes back as it is
 * stored and a listing keeps all of its entries.
 */
export function unscopedName(sessionId: string | undefined, scoped: string): string | undefined {
  if (sessionId === undefined) return scoped;
  const prefix = scopePrefix(sessionId);
  if (!scoped.startsWith(prefix)) return undefined;
  const local = scoped.slice(prefix.length);
  // A scoped name with a nested separator (`sess__a__b`) does not
  // round-trip through `scopedName`, so it can't have been minted
  // by this wrapper. Treat it as foreign.
  if (local.length === 0 || local.includes(SCOPE_SEPARATOR)) return undefined;
  return local;
}
