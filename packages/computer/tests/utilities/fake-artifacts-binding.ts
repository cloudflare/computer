// In-memory fake of the Artifacts Workers binding for tests.
//
// It implements the global `Artifacts` interface from
// `@cloudflare/workers-types` so the type checker holds it to the
// real wire shape. A fake that drifts from the binding is worse
// than no fake — it lets shape bugs pass green — so this one is
// pinned to the published interface and the test suite fails to
// compile if the binding's shape changes underneath it.
//
// It is not a faithful emulation of the service: tokens are opaque
// strings, ids are sequential, and there is no real git storage.
// But it honors the contracts the wrapper depends on — repository
// names must match the binding's documented charset, `list`
// paginates across every repo and omits `remote`, and `revokeToken`
// flips state.

import type { ArtifactScope } from "../../src/artifacts/types.js";

const VALID_BINDING_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface FakeToken extends ArtifactsTokenInfo {
  plaintext: string;
}

interface FakeRepo {
  info: ArtifactsRepoInfo;
  tokens: FakeToken[];
}

export interface FakeBindingOptions {
  /** Page size `list` chops its results into. Defaults to one page. */
  pageSize?: number;
}

export class FakeArtifactsBinding implements Artifacts {
  readonly repos = new Map<string, FakeRepo>();
  #seq = 0;
  #pageSize: number;

  constructor(options: FakeBindingOptions = {}) {
    this.#pageSize = options.pageSize ?? 1000;
  }

  /** Test helper: does a (scoped) repo name exist? */
  has(name: string): boolean {
    return this.repos.has(name);
  }

  #nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq}`;
  }

  #mintToken(scope: ArtifactScope, ttl: number): FakeToken {
    const id = this.#nextId("tok");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    return {
      id,
      scope,
      state: "active",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      // The real binding's plaintext carries a trailing
      // `?expires=<unix-seconds>` hint that is not part of the
      // credential. Mirror it so consumers that fold the token into a
      // URL are exercised against the real shape — a fake without it
      // lets that bug pass green.
      plaintext: `art_v1_${id}?expires=${Math.floor(expiresAt.getTime() / 1000)}`,
    };
  }

  #makeRepo(
    name: string,
    opts: { description?: string; readOnly?: boolean; defaultBranch?: string; source?: string },
  ): FakeRepo {
    const now = new Date().toISOString();
    const info: ArtifactsRepoInfo = {
      id: this.#nextId("repo"),
      name,
      description: opts.description ?? null,
      defaultBranch: opts.defaultBranch ?? "main",
      createdAt: now,
      updatedAt: now,
      lastPushAt: null,
      source: opts.source ?? null,
      readOnly: opts.readOnly ?? false,
      remote: `https://acct.artifacts.cloudflare.net/git/${name}.git`,
    };
    return { info, tokens: [] };
  }

  #createResult(repo: FakeRepo, token: FakeToken): ArtifactsCreateRepoResult {
    return {
      id: repo.info.id,
      name: repo.info.name,
      description: repo.info.description,
      defaultBranch: repo.info.defaultBranch,
      remote: repo.info.remote,
      token: token.plaintext,
      tokenExpiresAt: token.expiresAt,
    };
  }

  async create(
    name: string,
    opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {},
  ): Promise<ArtifactsCreateRepoResult> {
    assertBindingRepoName(name);
    if (this.repos.has(name)) {
      throw makeError("ALREADY_EXISTS", `repo already exists: ${name}`);
    }
    const repo = this.#makeRepo(name, {
      description: opts.description,
      readOnly: opts.readOnly,
      defaultBranch: opts.setDefaultBranch,
    });
    const token = this.#mintToken("write", 86400);
    repo.tokens.push(token);
    this.repos.set(name, repo);
    return this.#createResult(repo, token);
  }

  async get(name: string): Promise<ArtifactsRepo> {
    assertBindingRepoName(name);
    const repo = this.repos.get(name);
    if (!repo) throw makeError("NOT_FOUND", `no such repo: ${name}`);
    return new FakeRepoHandle(repo, (scope, ttl) => this.#mintToken(scope, ttl));
  }

  async list(opts: { limit?: number; cursor?: string } = {}): Promise<ArtifactsRepoListResult> {
    // `repos` omits the `remote` field per the binding contract.
    const all = [...this.repos.values()].map(({ info }) => {
      const { remote: _remote, ...rest } = info;
      return rest;
    });
    const pageSize = Math.min(opts.limit ?? this.#pageSize, this.#pageSize);
    const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const page = all.slice(start, start + pageSize);
    const next = start + pageSize;
    const cursor = next < all.length ? String(next) : undefined;
    return { repos: page, total: all.length, cursor };
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<ArtifactsCreateRepoResult> {
    const name = params.target.name;
    assertBindingRepoName(name);
    if (this.repos.has(name)) {
      throw makeError("ALREADY_EXISTS", `repo already exists: ${name}`);
    }
    const repo = this.#makeRepo(name, {
      description: params.target.opts?.description,
      readOnly: params.target.opts?.readOnly,
      defaultBranch: params.source.branch,
      source: params.source.url,
    });
    const token = this.#mintToken("write", 86400);
    repo.tokens.push(token);
    this.repos.set(name, repo);
    return this.#createResult(repo, token);
  }

  async delete(name: string): Promise<boolean> {
    assertBindingRepoName(name);
    return this.repos.delete(name);
  }
}

class FakeRepoHandle implements ArtifactsRepo {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastPushAt: string | null;
  readonly source: string | null;
  readonly readOnly: boolean;
  readonly remote: string;

  constructor(
    private readonly repo: FakeRepo,
    private readonly mint: (scope: ArtifactScope, ttl: number) => FakeToken,
  ) {
    const i = repo.info;
    this.id = i.id;
    this.name = i.name;
    this.description = i.description;
    this.defaultBranch = i.defaultBranch;
    this.createdAt = i.createdAt;
    this.updatedAt = i.updatedAt;
    this.lastPushAt = i.lastPushAt;
    this.source = i.source;
    this.readOnly = i.readOnly;
    this.remote = i.remote;
  }

  // The real binding exposes metadata through `info()` (the handle is
  // an RpcTarget whose data is not readable as stub properties), so
  // mirror that accessor here. The client reads metadata through this
  // method, not off the handle's fields.
  async info(): Promise<ArtifactsRepoInfo> {
    return { ...this.repo.info };
  }

  async createToken(
    scope: ArtifactScope = "write",
    ttl = 86400,
  ): Promise<ArtifactsCreateTokenResult> {
    const token = this.mint(scope, ttl);
    this.repo.tokens.push(token);
    return { id: token.id, plaintext: token.plaintext, scope, expiresAt: token.expiresAt };
  }

  async listTokens(): Promise<ArtifactsTokenListResult> {
    const tokens = this.repo.tokens.map(({ plaintext: _plaintext, ...info }) => info);
    return { tokens, total: tokens.length };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    const token = this.repo.tokens.find((t) => t.id === tokenOrId || t.plaintext === tokenOrId);
    if (!token || token.state === "revoked") return false;
    token.state = "revoked";
    return true;
  }

  async fork(
    name: string,
    _opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<ArtifactsCreateRepoResult> {
    // Not exercised by the wrapper today; satisfy the interface.
    throw makeError("INTERNAL_ERROR", `fork not implemented in fake: ${name}`);
  }
}

function assertBindingRepoName(name: string): void {
  if (!VALID_BINDING_REPO_NAME.test(name)) {
    throw makeError("INVALID_REPO_NAME", `invalid repo name: ${name}`);
  }
}

/** Build something shaped like the binding's `ArtifactsError`. */
function makeError(code: ArtifactsErrorCode, message: string): ArtifactsError {
  const err = new Error(message) as Error & {
    name: "ArtifactsError";
    code: ArtifactsErrorCode;
    numericCode: number;
  };
  err.name = "ArtifactsError";
  err.code = code;
  err.numericCode = 0;
  return err as unknown as ArtifactsError;
}
