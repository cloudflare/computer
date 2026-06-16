// Clone a remote repository into a workspace-backed filesystem.
//
// Subset-of-files support comes from isomorphic-git's two-step
// model: clone with `noCheckout: true` to populate `.git/`, then
// `checkout({ filepaths })` to materialize a chosen subset of the
// working tree. The wire protocol still ships every blob reachable
// from the tip tree — isomorphic-git does not speak the v2
// `filter` capability — but disk writes are limited to `paths`.
//
// `cloneWith` is the testable core: it takes a pre-built
// IsomorphicGitClient and HTTP transport. The public `clone()` in
// ./index.ts resolves those from dynamic imports of `isomorphic-git`
// so the peer dep stays optional and the base bundle pays no cost.

/**
 * The subset of `isomorphic-git`'s API consumed here. Declared
 * structurally to avoid pulling the package's `.d.ts` into this
 * package's public types, and to let tests pass plain spies.
 */
export interface IsomorphicGitClient {
  clone(args: {
    fs: object;
    http: object;
    dir: string;
    url: string;
    ref?: string;
    corsProxy?: string;
    headers?: Record<string, string>;
    depth?: number;
    singleBranch?: boolean;
    noTags?: boolean;
    noCheckout?: boolean;
    cache?: object;
    onProgress?: ProgressCallback;
    onMessage?: MessageCallback;
  }): Promise<void>;

  checkout(args: {
    fs: object;
    dir: string;
    ref: string;
    filepaths?: string[];
    force?: boolean;
    noUpdateHead?: boolean;
    cache?: object;
  }): Promise<void>;
}

export type ProgressCallback = (e: { phase: string; loaded: number; total?: number }) => void;
export type MessageCallback = (msg: string) => void;

export interface GitCloneOptions {
  /** Repository URL. HTTPS only — isomorphic-git has no SSH transport. */
  url: string;
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Branch, tag, or commit. Defaults to the remote's default branch. */
  ref?: string;
  /**
   * If set, only these paths are written into the working tree.
   * `.git/` is fully populated regardless (subject to `depth`).
   * Globs are not supported; pass directory or file paths.
   */
  paths?: string[];
  /**
   * Shallow-clone depth. Defaults to 1. Pass `0` or `Infinity` for
   * full history. Even with depth=1, every blob reachable from the
   * tip tree is fetched — see the package README for why.
   */
  depth?: number;
  /** Fetch only the requested ref's branch. Default: true. */
  singleBranch?: boolean;
  /** Skip tags. Default: true. */
  noTags?: boolean;
  /** Extra HTTP headers, e.g. `Authorization` for a private repo. */
  headers?: Record<string, string>;
  /** CORS proxy URL. Usually unneeded inside a Worker. */
  corsProxy?: string;
  /** Progress callback. Forwarded to isomorphic-git. */
  onProgress?: ProgressCallback;
  /** Sideband message callback. Forwarded to isomorphic-git. */
  onMessage?: MessageCallback;
}

/**
 * Dependency-injected form. Used directly by tests and by the
 * public `clone()` wrapper. Splitting this out keeps the import
 * graph clean: this file has no runtime dependency on
 * `isomorphic-git` or `@platformatic/vfs`.
 */
export interface CloneWithDeps extends GitCloneOptions {
  git: IsomorphicGitClient;
  http: object;
  fs: object;
  /**
   * isomorphic-git's pack/index cache. Pass the same object to
   * every isogit call against this repo so the packfile is parsed
   * once. Without this, each `readBlob` / `walk` / `statusMatrix`
   * re-parses the pack from the SQLite-backed VFS (~tens of MB),
   * which is the difference between sub-second diffs and minutes.
   */
  cache?: object;
}

export async function cloneWith(opts: CloneWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  const ref = opts.ref;
  const depthRaw = opts.depth ?? 1;
  // depth=0 and depth=Infinity both mean "no shallow limit" on this
  // surface. isomorphic-git interprets `undefined` that way.
  const depth = depthRaw > 0 && Number.isFinite(depthRaw) ? depthRaw : undefined;

  await opts.git.clone({
    fs: opts.fs,
    http: opts.http,
    dir,
    url: opts.url,
    ref,
    corsProxy: opts.corsProxy,
    headers: opts.headers,
    depth,
    singleBranch: opts.singleBranch ?? true,
    noTags: opts.noTags ?? true,
    noCheckout: true,
    cache: opts.cache,
    onProgress: opts.onProgress,
    onMessage: opts.onMessage,
  });

  // The working tree is empty after a noCheckout clone, so `force`
  // is safe — nothing real can conflict — and matches caller intent
  // ("populate this workspace from the remote").
  //
  // `git.clone` already wrote HEAD as a symbolic ref to the fetched
  // branch. Checking out `ref: "HEAD"` here would re-resolve it to
  // an oid and detach HEAD, because isomorphic-git only writes a
  // symbolic HEAD when the checkout ref expands to `refs/heads/*`.
  // `noUpdateHead` materializes the working tree without touching
  // HEAD, preserving the symbolic ref the clone left in place.
  await opts.git.checkout({
    fs: opts.fs,
    dir,
    ref: ref ?? "HEAD",
    filepaths: opts.paths,
    force: true,
    noUpdateHead: true,
    cache: opts.cache,
  });
}
