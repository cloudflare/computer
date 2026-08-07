// Unified-diff between a git ref (default HEAD) and the working
// tree, the way `git diff HEAD` would, but in pure JS via
// isomorphic-git + the `diff` package.
//
// `diffWith` is the testable core: takes a pre-built
// IsomorphicGitDiffClient, an FsClient, a `createPatch` function,
// and a `readFile` function. The public `diff()` in ./index.ts
// resolves those from dynamic imports of `isomorphic-git` and
// `diff` so both stay optional peer deps.

import type { IsomorphicGitFSClient } from "./adapter.js";
import type { StatusMatrixRow } from "./status.js";

/**
 * Status-matrix row as emitted by isomorphic-git's `statusMatrix`:
 * `[filepath, headStatus, workdirStatus, stageStatus]`.
 *   - 0 = absent
 *   - 1 = same as HEAD
 *   - 2 = differs from HEAD
 *   - 3 = differs from HEAD and stage (rarely meaningful here)
 */
export type StatusRow = StatusMatrixRow;

/** Subset of isomorphic-git's API used to compute a working-tree diff. */
export interface IsomorphicGitDiffClient {
  resolveRef(args: { fs: object; dir: string; ref: string }): Promise<string>;
  statusMatrix(args: {
    fs: object;
    dir: string;
    ref?: string;
    cache?: object;
  }): Promise<StatusMatrixRow[]>;
  readBlob(args: {
    fs: object;
    dir: string;
    oid: string;
    filepath: string;
    cache?: object;
  }): Promise<{ blob: Uint8Array; oid: string }>;
  listFiles?(args: { fs: object; dir: string; ref?: string }): Promise<string[]>;
}

/** Signature compatible with the `diff` package's `createPatch`. */
export type CreatePatchFn = (
  fileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
) => string;

/** Signature compatible with `fs.promises.readFile` (binary mode). */
export type ReadFileFn = (path: string) => Promise<Uint8Array | string>;

export interface GitDiffOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /**
   * Ref to diff against. Defaults to `HEAD`. When `to` is also
   * set, this is the "from" side of a ref-to-ref diff.
   */
  ref?: string;
  /**
   * Second ref. When set, diff is `ref` -> `to` (both committed
   * states), not `ref` -> working tree. Useful for `git diff
   * <a>..<b>` semantics without spinning up a working-tree
   * round-trip.
   */
  to?: string;
  /**
   * Restrict the diff to these working-tree paths. When omitted,
   * every path that changed between the two endpoints is
   * included.
   */
  paths?: string[];
}

/**
 * Dependency-injected form. Used directly by tests and by the
 * public `diff()` wrapper.
 */
export interface DiffWithDeps extends GitDiffOptions {
  git: IsomorphicGitDiffClient;
  fs: IsomorphicGitFSClient | object;
  createPatch: CreatePatchFn;
  readFile: ReadFileFn;
  /**
   * isomorphic-git's pack/index cache. Shared with the surrounding
   * GitClient so the packfile is parsed once across clone, diff,
   * and any other isogit call. See clone.ts's CloneWithDeps.cache.
   */
  cache?: object;
}

/**
 * One changed path with both endpoints' text. The shared
 * collector below produces these; `diffWith` renders them into a
 * patch and `diffSummaryWith` counts lines off them, so the two
 * surfaces walk identical change sets.
 */
interface DiffEntry {
  path: string;
  /** Single-char status: 'A' added, 'M' modified, 'D' deleted. */
  status: "A" | "M" | "D";
  /** Text on the "from" side ("" when absent / added). */
  oldText: string;
  /** Text on the "to" side ("" when absent / deleted). */
  newText: string;
}

/** Per-file change summary for `--stat` / `--name-status`. */
export interface DiffSummaryEntry {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export async function diffWith(opts: DiffWithDeps): Promise<string> {
  const entries = await collectDiffEntries(opts);
  const chunks: string[] = [];
  for (const e of entries) {
    const patch = opts.createPatch(e.path, e.oldText, e.newText, "", "");
    if (patch.trim().length > 0) chunks.push(patch);
  }
  return chunks.join("\n");
}

/**
 * Per-file summary of the same change set `diffWith` renders,
 * with insertion / deletion line counts derived from the patch.
 * Backs `git diff --stat` / `--name-only` / `--name-status`.
 */
export async function diffSummaryWith(opts: DiffWithDeps): Promise<DiffSummaryEntry[]> {
  const entries = await collectDiffEntries(opts);
  return entries.map((e) => {
    const { insertions, deletions } = countChanges(
      opts.createPatch(e.path, e.oldText, e.newText, "", ""),
    );
    return { path: e.path, status: e.status, insertions, deletions };
  });
}

// Shared traversal. Working-tree mode walks the status matrix;
// ref-to-ref mode walks the union of both trees' files. Both
// yield `DiffEntry`s with each side's text resolved.
async function collectDiffEntries(opts: DiffWithDeps): Promise<DiffEntry[]> {
  const dir = opts.dir ?? "/";
  const ref = opts.ref ?? "HEAD";

  if (opts.to !== undefined) {
    return collectRefToRef(opts, dir, ref, opts.to);
  }

  let head: string;
  try {
    head = await opts.git.resolveRef({ fs: opts.fs, dir, ref });
  } catch {
    // Ref unresolvable (e.g. workspace never cloned). An empty
    // change set is a more useful signal than an exception for
    // the common "diff after maybe-no-op" call site.
    return [];
  }

  // Pass `ref` through so the matrix is computed against the
  // requested commit rather than always HEAD. Without this the
  // `ref` argument would only affect blob reads, leaving the
  // status walk silently skewed.
  const status = await opts.git.statusMatrix({ fs: opts.fs, dir, ref, cache: opts.cache });
  const pathFilter = makePathFilter(opts.paths);
  const entries: DiffEntry[] = [];
  for (const [filepath, headStatus, workdirStatus] of status) {
    // workdirStatus: 0 absent, 1 == HEAD, 2 differs. Skip
    // unchanged rows up front to avoid the blob/file reads.
    if (workdirStatus === 1) continue;
    if (!pathFilter(filepath)) continue;

    const oldText =
      headStatus === 1
        ? await readBlobAsText(opts.git, opts.fs, dir, head, filepath, opts.cache)
        : "";
    const newText =
      workdirStatus === 2 ? await readWorkdirAsText(opts.readFile, dir, filepath) : "";
    if (oldText === newText) continue;
    // headStatus 0 -> not in the base -> added. workdirStatus 0
    // -> gone from the working tree -> deleted. Otherwise it's a
    // content change.
    const status: DiffEntry["status"] = headStatus === 0 ? "A" : workdirStatus === 0 ? "D" : "M";
    entries.push({ path: filepath, status, oldText, newText });
  }
  return entries;
}

// Ref-to-ref collector. Walk the union of both commits' file
// lists — git's own object database, no working-tree probes —
// and resolve each path's blob in both commits.
async function collectRefToRef(
  opts: DiffWithDeps,
  dir: string,
  from: string,
  to: string,
): Promise<DiffEntry[]> {
  let fromOid: string;
  let toOid: string;
  try {
    fromOid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: from });
    toOid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: to });
  } catch {
    return [];
  }
  const fromFiles = new Set(await listFilesAt(opts.git, opts.fs, dir, from));
  const toFiles = new Set(await listFilesAt(opts.git, opts.fs, dir, to));
  const union = new Set<string>([...fromFiles, ...toFiles]);
  const pathFilter = makePathFilter(opts.paths);

  const entries: DiffEntry[] = [];
  for (const filepath of [...union].sort()) {
    if (!pathFilter(filepath)) continue;
    const inFrom = fromFiles.has(filepath);
    const inTo = toFiles.has(filepath);
    const a = inFrom
      ? await readBlobAsText(opts.git, opts.fs, dir, fromOid, filepath, opts.cache)
      : "";
    const b = inTo ? await readBlobAsText(opts.git, opts.fs, dir, toOid, filepath, opts.cache) : "";
    if (a === b) continue;
    const status: DiffEntry["status"] = !inFrom ? "A" : !inTo ? "D" : "M";
    entries.push({ path: filepath, status, oldText: a, newText: b });
  }
  return entries;
}

/**
 * Count added / removed content lines in a unified patch. Only
 * count lines inside hunks (after an `@@` header) so file headers
 * are ignored while real content that begins with `+++` / `---`
 * is still counted. Good enough for `--stat`'s numeric column,
 * which is all the CLI needs.
 */
function countChanges(patch: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { insertions, deletions };
}

async function listFilesAt(
  git: IsomorphicGitDiffClient,
  fs: object,
  dir: string,
  ref: string,
): Promise<string[]> {
  if (typeof git.listFiles !== "function") return [];
  return git.listFiles({ fs, dir, ref });
}

function makePathFilter(paths: string[] | undefined): (p: string) => boolean {
  if (paths === undefined || paths.length === 0) return () => true;
  // Match either an exact path or a directory prefix. Globs are
  // not supported on this surface; the docs call this out
  // explicitly under the `diff` command reference.
  const exact = new Set(paths.map((p) => normalizePath(p)));
  const prefixes = [...exact].map((p) => `${p}/`);
  return (candidate) => {
    const c = normalizePath(candidate);
    if (exact.has(c)) return true;
    for (const prefix of prefixes) if (c.startsWith(prefix)) return true;
    return false;
  };
}

function normalizePath(p: string): string {
  // Drop leading './' and trailing '/'.
  let out = p;
  if (out.startsWith("./")) out = out.slice(2);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

async function readBlobAsText(
  git: IsomorphicGitDiffClient,
  fs: object,
  dir: string,
  oid: string,
  filepath: string,
  cache: object | undefined,
): Promise<string> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath, cache });
    // Best-effort UTF-8 decode. A real diff tool would skip
    // binaries entirely; for the general case here a noisy diff
    // beats a thrown error.
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(blob);
  } catch {
    return "";
  }
}

async function readWorkdirAsText(
  readFile: ReadFileFn,
  dir: string,
  filepath: string,
): Promise<string> {
  try {
    const data = await readFile(`${dir}/${filepath}`);
    if (typeof data === "string") return data;
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(data);
  } catch {
    return "";
  }
}
