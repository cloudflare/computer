// Plumbing tail: hashObject, catFile, updateRef, and config.
//
// These exist mostly for scripts that drive a workspace from
// the shell side and need the lower-level building blocks real
// git's plumbing commands expose. The wrappers stay thin: they
// translate the workspace's option shape to isomorphic-git's
// shape and map the underlying NotFoundError-shaped failures
// to NotARepositoryError through the shared heuristic.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

export interface IsomorphicGitPlumbingClient {
  hashBlob(args: { object: Uint8Array | string }): Promise<{ oid: string; type: string }>;
  writeBlob(args: { fs: object; dir: string; blob: Uint8Array }): Promise<string>;
  readBlob(args: {
    fs: object;
    dir: string;
    oid: string;
    filepath?: string;
    cache?: object;
  }): Promise<{ oid: string; blob: Uint8Array }>;
  readObject(args: {
    fs: object;
    dir: string;
    oid: string;
    format?: "content" | "parsed" | "deflated" | "wrapped";
    cache?: object;
  }): Promise<
    | { oid: string; type: string; format: string; object: Uint8Array }
    | { oid: string; type: string; format: string; object: unknown }
  >;
  writeRef(args: {
    fs: object;
    dir: string;
    ref: string;
    value: string;
    force?: boolean;
    symbolic?: boolean;
  }): Promise<void>;
  getConfig(args: { fs: object; dir: string; path: string }): Promise<unknown>;
  getConfigAll(args: { fs: object; dir: string; path: string }): Promise<unknown[]>;
  setConfig(args: {
    fs: object;
    dir: string;
    path: string;
    value: string | boolean | number | undefined;
    append?: boolean;
  }): Promise<void>;
}

// ---------------------------------------------------------------
// hashObject
// ---------------------------------------------------------------

export interface GitHashObjectOptions {
  dir?: string;
  /** Raw bytes to hash. */
  content: Uint8Array | string;
  /** Write the resulting blob into the object store. Defaults to `false`. */
  write?: boolean;
}

export interface HashObjectWithDeps extends GitHashObjectOptions {
  git: IsomorphicGitPlumbingClient;
  fs: object;
}

export async function hashObjectWith(opts: HashObjectWithDeps): Promise<string> {
  const dir = opts.dir ?? "/";
  // hashBlob is pure (no fs) and gives us the oid without
  // writing. When the caller asks for write, hand the bytes to
  // writeBlob so the object lands in the store. The two paths
  // produce identical oids for the same input, so the typed
  // surface returns just the oid in both cases.
  const bytes =
    typeof opts.content === "string" ? new TextEncoder().encode(opts.content) : opts.content;
  try {
    if (opts.write) {
      return await opts.git.writeBlob({ fs: opts.fs, dir, blob: bytes });
    }
    const { oid } = await opts.git.hashBlob({ object: bytes });
    return oid;
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EHASHFAIL", `git hash-object failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// catFile
// ---------------------------------------------------------------

export interface GitCatFileOptions {
  dir?: string;
  /** Object id to read. */
  oid: string;
  /**
   * Sub-path inside a tree. Only valid for tree-shaped oids;
   * matches real git's `git cat-file -p <tree>:<path>` shape.
   */
  filepath?: string;
}

export interface CatFileWithDeps extends GitCatFileOptions {
  git: IsomorphicGitPlumbingClient;
  fs: object;
  cache?: object;
}

export interface CatFileResult {
  oid: string;
  /** Raw object bytes. */
  bytes: Uint8Array;
}

export async function catFileWith(opts: CatFileWithDeps): Promise<CatFileResult> {
  const dir = opts.dir ?? "/";
  try {
    // readBlob is the right tool when we already know the oid
    // resolves to a blob; for tree / commit oids it errors out.
    // We try readBlob first (fast path); fall back to readObject
    // when the caller doesn't know the type up front.
    if (opts.filepath !== undefined) {
      const { oid, blob } = await opts.git.readBlob({
        fs: opts.fs,
        dir,
        oid: opts.oid,
        filepath: opts.filepath,
        cache: opts.cache,
      });
      return { oid, bytes: blob };
    }
    try {
      const { oid, blob } = await opts.git.readBlob({
        fs: opts.fs,
        dir,
        oid: opts.oid,
        cache: opts.cache,
      });
      return { oid, bytes: blob };
    } catch {
      // Not a blob; fall through to readObject's content form.
    }
    const obj = await opts.git.readObject({
      fs: opts.fs,
      dir,
      oid: opts.oid,
      format: "content",
      cache: opts.cache,
    });
    const bytes =
      obj.object instanceof Uint8Array ? obj.object : new TextEncoder().encode(String(obj.object));
    return { oid: obj.oid, bytes };
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECATFILEFAIL", `git cat-file failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// updateRef
// ---------------------------------------------------------------

export interface GitUpdateRefOptions {
  dir?: string;
  /** Ref to update, e.g. "refs/heads/main" or a short name. */
  ref: string;
  /** Oid the ref should point at. */
  value: string;
  /** Allow overwriting a non-fast-forward update. Defaults to `false`. */
  force?: boolean;
  /**
   * Write a symbolic ref (e.g. HEAD -> refs/heads/main) rather
   * than a direct oid. Defaults to `false`.
   */
  symbolic?: boolean;
}

export interface UpdateRefWithDeps extends GitUpdateRefOptions {
  git: IsomorphicGitPlumbingClient;
  fs: object;
}

export async function updateRefWith(opts: UpdateRefWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.writeRef({
      fs: opts.fs,
      dir,
      ref: opts.ref,
      value: opts.value,
      force: opts.force,
      symbolic: opts.symbolic,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EUPDATEREFFAIL", `git update-ref failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// config
// ---------------------------------------------------------------

export interface GitConfigGetOptions {
  dir?: string;
  /** Config key, e.g. "user.email". */
  path: string;
  /** Return every value for a multi-valued key. Defaults to `false`. */
  all?: boolean;
}

export interface ConfigGetWithDeps extends GitConfigGetOptions {
  git: IsomorphicGitPlumbingClient;
  fs: object;
}

/**
 * Get a config value. Returns `undefined` if the key is unset
 * (rather than throwing), matching the behavior of `git config
 * --get` which exits 1 with no output for an unknown key.
 */
export async function configGetWith(
  opts: ConfigGetWithDeps,
): Promise<string | string[] | undefined> {
  const dir = opts.dir ?? "/";
  try {
    if (opts.all) {
      const values = await opts.git.getConfigAll({ fs: opts.fs, dir, path: opts.path });
      return values.map((v) => String(v));
    }
    const value = await opts.git.getConfig({ fs: opts.fs, dir, path: opts.path });
    if (value === undefined || value === null) return undefined;
    return String(value);
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECONFIGFAIL", `git config failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export interface GitConfigSetOptions {
  dir?: string;
  path: string;
  /**
   * Value to write. `undefined` unsets the key, matching
   * `git config --unset`.
   */
  value: string | boolean | number | undefined;
  /** Append to a multi-valued key rather than replacing. */
  append?: boolean;
}

export interface ConfigSetWithDeps extends GitConfigSetOptions {
  git: IsomorphicGitPlumbingClient;
  fs: object;
}

export async function configSetWith(opts: ConfigSetWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  try {
    await opts.git.setConfig({
      fs: opts.fs,
      dir,
      path: opts.path,
      value: opts.value,
      append: opts.append,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECONFIGFAIL", `git config failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
