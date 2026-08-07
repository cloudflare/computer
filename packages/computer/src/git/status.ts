// `git status` — describe the working-tree / index / HEAD delta.
//
// Returns a structured form (`StatusEntry[]`) that the CLI's
// formatters render into either porcelain v2 (default) or
// `--short` output. We don't try to mirror the full `git status`
// long-form output; nobody parses that, and the porcelain shapes
// already give consumers everything machine-readable.
//
// isomorphic-git's `statusMatrix` is the source of truth. The
// per-row tuple is `[filepath, headStatus, workdirStatus,
// stageStatus]` where each numeric column means:
//
//   headStatus: 0 absent in HEAD, 1 present in HEAD
//   workdirStatus: 0 absent, 1 == HEAD, 2 != HEAD
//   stageStatus: 0 absent, 1 == HEAD, 2 != HEAD and != workdir,
//                3 == workdir but != HEAD
//
// From that we derive two XY-style chars for porcelain output:
// X = index-vs-HEAD, Y = workdir-vs-index. The mapping is
// covered by tests.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

export type StatusMatrixRow = [
  filepath: string,
  headStatus: number,
  workdirStatus: number,
  stageStatus: number,
];

/** Subset of `isomorphic-git`'s API used for `status`. */
export interface IsomorphicGitStatusClient {
  statusMatrix(args: { fs: object; dir: string; cache?: object }): Promise<StatusMatrixRow[]>;
}

export interface GitStatusOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
}

export interface StatusWithDeps extends GitStatusOptions {
  git: IsomorphicGitStatusClient;
  fs: object;
  cache?: object;
}

/**
 * One entry per non-clean path. `index` describes the staged
 * delta against HEAD; `worktree` describes the working-tree
 * delta against the staged version. Both are single-char codes
 * matching git's XY convention:
 *
 *   ' ' (space) unmodified
 *   'A' added
 *   'M' modified
 *   'D' deleted
 *   '?' untracked (Y only)
 */
export interface StatusEntry {
  path: string;
  index: " " | "A" | "M" | "D";
  worktree: " " | "A" | "M" | "D" | "?";
}

export async function statusWith(opts: StatusWithDeps): Promise<StatusEntry[]> {
  const dir = opts.dir ?? "/";
  let rows: StatusMatrixRow[];
  try {
    rows = await opts.git.statusMatrix({ fs: opts.fs, dir, cache: opts.cache });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESTATUSFAIL", `git status failed: ${errorMessage(cause)}`, { cause });
  }

  const out: StatusEntry[] = [];
  for (const [path, head, workdir, stage] of rows) {
    // Skip fully clean rows.
    if (head === 1 && workdir === 1 && stage === 1) continue;
    const index = indexCode(head, stage);
    const worktree = worktreeCode(head, workdir, stage);
    if (index === " " && worktree === " ") continue;
    out.push({ path, index, worktree });
  }
  // Stable ordering by path. Real git is lexicographic; match it
  // so a snapshot doesn't churn on cache iteration order.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// Derive the X (index-vs-HEAD) column.
//   HEAD absent, stage present     -> A
//   HEAD present, stage absent     -> D
//   HEAD present, stage != HEAD    -> M (stage is "version 2")
//   otherwise                      -> ' '
function indexCode(head: number, stage: number): StatusEntry["index"] {
  if (head === 0 && stage > 0) return "A";
  if (head === 1 && stage === 0) return "D";
  // stage === 2 means "differs from HEAD" (anywhere, regardless of workdir);
  // stage === 3 means "differs from HEAD but matches workdir" — still a
  // staged modification against HEAD.
  if (head === 1 && (stage === 2 || stage === 3)) return "M";
  return " ";
}

// Derive the Y (workdir-vs-index) column.
//   workdir absent, stage present -> 'D' (deleted in workdir)
//   not in HEAD, not in stage     -> '?' (untracked)
//   workdir differs from stage    -> 'M'
//   workdir same as stage         -> ' '
function worktreeCode(head: number, workdir: number, stage: number): StatusEntry["worktree"] {
  if (workdir === 0 && stage > 0) return "D";
  if (head === 0 && stage === 0 && workdir > 0) return "?";
  // workdirStatus 2 means "differs from HEAD"; stageStatus 3 means
  // "differs from HEAD but matches workdir" — so workdir == stage,
  // nothing further to report on Y.
  if (workdir === 2 && stage !== 3) return "M";
  return " ";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Render `entries` as porcelain v2 lines. */
export function formatPorcelainV2(entries: StatusEntry[]): string {
  // git's porcelain v2 uses headers per record and mode/oid
  // fields we don't compute. We emit a simplified shape that
  // matches the v2 *changed-files* line prefix (`1 <XY> ...`)
  // and the untracked prefix (`? <path>`) — enough for a CLI
  // consumer that just wants a programmatic list. The full
  // header-with-mtime form is deferred until a caller needs it.
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    if (e.worktree === "?") {
      lines.push(`? ${e.path}`);
    } else {
      lines.push(`1 ${e.index}${e.worktree} ${e.path}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render `entries` as porcelain v1 lines (`XY <path>`). Identical
 * to `--short` except untracked files use the `??` two-char code
 * real git's porcelain v1 emits rather than the ` ?` short form,
 * so a v1 parser sees the shape it expects.
 */
export function formatPorcelainV1(entries: StatusEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    if (e.worktree === "?") {
      lines.push(`?? ${e.path}`);
    } else {
      lines.push(`${e.index}${e.worktree} ${e.path}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Render `entries` as `--short` output. */
export function formatShort(entries: StatusEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`${e.index}${e.worktree} ${e.path}`);
  }
  return `${lines.join("\n")}\n`;
}
