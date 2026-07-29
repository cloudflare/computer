// Session-scoped facade over the Cloudflare Artifacts Workers
// binding.
//
// `createArtifact(binding, sessionId)` binds a namespace binding
// and a session id once and returns a client whose every method is
// implicitly scoped to that session. The session id is a name
// prefix: `create("starter")` stores `${sessionId}__starter` in the
// namespace, and `list()` returns only the session's own repos with
// the prefix stripped back off. A caller never sees the scoped form
// — names go in and come out local.
//
// The binding, its repo handle, and the result shapes are the
// global types from `@cloudflare/workers-types` (`Artifacts`,
// `ArtifactsRepo`, `ArtifactsCreateRepoResult`, `ArtifactsRepoInfo`,
// ...). The facade adds session scoping on top; it does not
// redeclare the wire shapes.
//
// The typed surface here is the single source of truth. The argv-
// driven CLI in `cli.ts` dispatches through this same client, so
// the two surfaces cannot drift.

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "./cli.js";
import { runArtifactsCLI } from "./cli.js";
import { NotFoundError } from "./errors.js";
import { scopedName, scopePrefix, unscopedName } from "./scope.js";
import type { ArtifactScope } from "./types.js";

/** Source spec for `import`. Mirrors the binding's `source` block. */
export interface ArtifactImportSource {
  url: string;
  branch?: string;
  depth?: number;
}

/** Options for `import`'s target repo. */
export interface ArtifactImportOptions {
  description?: string;
  readOnly?: boolean;
}

/**
 * A repo summary as returned by `list`: the binding's
 * `ArtifactsRepoInfo` without the `remote` field, with the `name`
 * rewritten to its local (unscoped) form.
 */
export type ArtifactRepoSummary = Omit<ArtifactsRepoInfo, "remote">;

/** The session-scoped client. */
export interface ArtifactClient {
  /** The session id every operation is scoped under. */
  readonly sessionId: string;

  /** Create a repo. The returned `name` is local (unscoped). */
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResult>;
  /**
   * Resolve repository metadata. The returned `name` is local.
   * Throws `ArtifactsError` (code `NOT_FOUND`) if it does not exist.
   */
  get(name: string): Promise<ArtifactsRepoInfo>;
  /** List the session's repos, walking every page. Names are local. */
  list(): Promise<ArtifactRepoSummary[]>;
  /** Import an external git remote into a session repo. */
  import(
    name: string,
    source: ArtifactImportSource,
    opts?: ArtifactImportOptions,
  ): Promise<ArtifactsCreateRepoResult>;
  /** Delete a repo. Returns false when it does not exist. */
  delete(name: string): Promise<boolean>;

  /** Mint a git token for a session repo. */
  createToken(
    name: string,
    scope?: ArtifactScope,
    ttl?: number,
  ): Promise<ArtifactsCreateTokenResult>;
  /** List a session repo's token page (metadata only — no plaintext). */
  listTokens(name: string): Promise<ArtifactsTokenListResult>;
  /**
   * Get a single token's metadata by id. The binding has no direct
   * accessor and no token-list cursor, so this filters the page
   * returned by `listTokens()` and throws `NotFoundError` on a miss.
   */
  getToken(name: string, id: string): Promise<ArtifactsTokenInfo>;
  /** Revoke a token by id or plaintext. Returns false on a miss. */
  revokeToken(name: string, tokenOrId: string): Promise<boolean>;

  /**
   * Argv-driven entry point. The worker-backend's `artifacts`
   * custom command dispatches through this; in-process callers can
   * use it too when they want CLI-shaped output.
   */
  cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult>;
}

/**
 * Internal page size for `list`'s walk. The binding caps at 200;
 * 100 keeps each round trip modest while still draining quickly.
 */
const LIST_PAGE_SIZE = 100;

/** Build a session-scoped artifacts client over a namespace binding. */
export function createArtifact(binding: Artifacts, sessionId: string): ArtifactClient {
  // Validate the session id eagerly so a bad id fails at
  // construction rather than on first use.
  scopePrefix(sessionId);

  const client: ArtifactClient = {
    sessionId,

    async create(name, opts) {
      const result = await binding.create(scopedName(sessionId, name), opts);
      return { ...result, name: unscopeOr(sessionId, result.name, name) };
    },

    async get(name) {
      const handle = await binding.get(scopedName(sessionId, name));
      // The handle is a live Workers-RPC stub (ArtifactsRepo extends
      // RpcTarget). The published `@cloudflare/workers-types` shape is
      // wrong in both directions: it models the metadata as inherited
      // `ArtifactsRepoInfo` properties (which the runtime stub does
      // not expose — reading `handle.remote` yields an RpcPromise for
      // a nonexistent method) and omits `info()` (which the runtime
      // does have, returning the metadata by value). Reach `info()`
      // through a typed view until the published types are corrected.
      const view = handle as unknown as { info(): Promise<ArtifactsRepoInfo> };
      const info = await view.info();
      return repoInfo(info, name);
    },

    async list() {
      const out: ArtifactRepoSummary[] = [];
      let cursor: string | undefined;
      let done = false;
      const seenCursors = new Set<string>();
      while (!done) {
        const page = await binding.list({ limit: LIST_PAGE_SIZE, cursor });
        for (const repo of page.repos) {
          const local = unscopedName(sessionId, repo.name);
          if (local !== undefined) out.push({ ...repo, name: local });
        }
        const next = page.cursor;
        if (next === undefined) {
          done = true;
        } else {
          if (seenCursors.has(next)) {
            throw new Error(`artifacts list returned a non-advancing cursor: ${next}`);
          }
          seenCursors.add(next);
          cursor = next;
        }
      }
      return out;
    },

    async import(name, source, opts) {
      const result = await binding.import({
        source,
        target: { name: scopedName(sessionId, name), opts },
      });
      return { ...result, name: unscopeOr(sessionId, result.name, name) };
    },

    async delete(name) {
      return binding.delete(scopedName(sessionId, name));
    },

    async createToken(name, scope, ttl) {
      const handle = await binding.get(scopedName(sessionId, name));
      return handle.createToken(scope, ttl);
    },

    async listTokens(name) {
      const handle = await binding.get(scopedName(sessionId, name));
      return handle.listTokens();
    },

    async getToken(name, id) {
      const handle = await binding.get(scopedName(sessionId, name));
      const { tokens } = await handle.listTokens();
      const found = tokens.find((t) => t.id === id);
      if (!found) {
        throw new NotFoundError(`no such token '${id}' in repo '${name}'`);
      }
      return found;
    },

    async revokeToken(name, tokenOrId) {
      const handle = await binding.get(scopedName(sessionId, name));
      return handle.revokeToken(tokenOrId);
    },

    async cli(input) {
      return runArtifactsCLI(client, input);
    },
  };

  return client;
}

/**
 * Project an `ArtifactsRepoInfo` (or the `ArtifactsRepo` handle,
 * which extends it) to a plain metadata object with the name in its
 * local form. The caller resolves the live `info()` value first, so
 * every field here is already a plain value.
 */
function repoInfo(info: ArtifactsRepoInfo, localName: string): ArtifactsRepoInfo {
  return {
    id: info.id,
    name: localName,
    description: info.description,
    defaultBranch: info.defaultBranch,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    lastPushAt: info.lastPushAt,
    source: info.source,
    readOnly: info.readOnly,
    remote: info.remote,
  };
}

/**
 * Unscope a name the binding echoed back, falling back to the local
 * name the caller passed. The binding returns the scoped name it
 * stored; if it ever returns something without our prefix, prefer
 * the caller's local name over leaking a foreign-looking value.
 */
function unscopeOr(sessionId: string, returned: string, fallback: string): string {
  return unscopedName(sessionId, returned) ?? fallback;
}
