import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { iterateFoundEntries } from "./find.js";
import { readCommittedFileByInode, readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";

export interface WorkspaceGrepContextLine {
  line: number;
  text: string;
  isMatch: boolean;
}

export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
  context?: WorkspaceGrepContextLine[];
}

export interface GrepOptions {
  /** Ignore letter case. Defaults to false. */
  ignoreCase?: boolean;
  /** Interpret the pattern as a regular expression. Defaults to false. */
  regex?: boolean;
  /** Lines of context to include before and after each match. */
  context?: number;
  /** Maximum matches to return. */
  limit?: number;
  /** Matching lines to skip before collecting results. */
  offset?: number;
  /** Glob relative to a searched directory that limits files. */
  include?: string;
  /**
   * Whole-segment names to skip during traversal. Excluded directories
   * are never descended into, so their files are never read. Unlike
   * `include`, which filters files after the walk has already visited
   * them, this prunes the walk itself.
   */
  exclude?: string[];
}

interface ScanState {
  seen: number;
  accepted: number;
}

interface NumberedLine {
  line: number;
  text: string;
}

interface PendingMatch {
  match: WorkspaceGrepMatch;
  remaining: number;
}

export async function grep(
  db: Database,
  pattern: string,
  path: string,
  options: GrepOptions = {},
): Promise<WorkspaceGrepMatch[]> {
  const { path: canonical } = canonicalizePath(path);
  const node = resolveInode(db, canonical);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
  }

  const settings = normalizeOptions(options);
  if (settings.limit === 0) return [];
  const matcher = compileMatcher(pattern, {
    regex: settings.regex,
    ignoreCase: settings.ignoreCase,
  });
  const matches: WorkspaceGrepMatch[] = [];
  const state: ScanState = { seen: 0, accepted: 0 };
  const filePaths: Iterable<ScanTarget> =
    node.type === "file"
      ? [{ path: canonical, inode: node.inode, size: node.size }]
      : filesUnder(db, canonical, options.include, options.exclude);
  for (const target of filePaths) {
    const complete = await scanFile(
      db,
      target,
      matcher,
      settings.context,
      settings.offset,
      settings.limit,
      state,
      matches,
    );
    if (complete) break;
  }
  return matches;
}

function normalizeOptions(options: GrepOptions): {
  ignoreCase: boolean;
  regex: boolean;
  context: number;
  limit: number;
  offset: number;
} {
  const context = options.context ?? 0;
  if (!Number.isSafeInteger(context) || context < 0) {
    throw new TypeError("grep context must be a non-negative safe integer");
  }
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("grep limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("grep offset must be a non-negative safe integer");
  }
  return {
    ignoreCase: options.ignoreCase ?? false,
    regex: options.regex ?? false,
    context,
    limit,
    offset,
  };
}

interface ScanTarget {
  path: string;
  // Undefined when the caller grepped a single file directly: that
  // path still needs a normal resolve. Traversal-produced targets
  // carry the inode the walk already read.
  inode?: number;
  size?: number;
}

function* filesUnder(
  db: Database,
  directory: string,
  include: string | undefined,
  exclude: string[] | undefined,
): Iterable<ScanTarget> {
  for (const entry of iterateFoundEntries(db, directory, include, exclude)) {
    if (entry.type === "file") {
      yield { path: entry.path, inode: entry.inode, size: entry.size };
    }
  }
}

function compileMatcher(pattern: string, options: { regex: boolean; ignoreCase: boolean }): RegExp {
  const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new TypeError(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function scanFile(
  db: Database,
  target: ScanTarget,
  matcher: RegExp,
  context: number,
  offset: number,
  limit: number,
  state: ScanState,
  out: WorkspaceGrepMatch[],
): Promise<boolean> {
  const before: WorkspaceGrepContextLine[] = [];
  const pending: PendingMatch[] = [];
  const path = target.path;

  for await (const current of readLines(db, target)) {
    const isMatch = matcher.test(current.text);
    const contextLine = { ...current, isMatch };
    for (const item of pending) {
      item.match.context?.push({ ...contextLine });
      item.remaining -= 1;
    }
    flushReady(pending, out);
    if (state.accepted >= limit && pending.length === 0) return true;

    if (isMatch) {
      const matchIndex = state.seen;
      state.seen += 1;
      if (matchIndex >= offset && state.accepted < limit) {
        const match: WorkspaceGrepMatch = { path, line: current.line, text: current.text };
        if (context > 0) {
          match.context = [...before.map((line) => ({ ...line })), { ...contextLine }];
          pending.push({ match, remaining: context });
        } else {
          out.push(match);
        }
        state.accepted += 1;
      }
    }

    before.push(contextLine);
    if (before.length > context) before.shift();
    if (state.accepted >= limit && pending.length === 0) return true;
  }

  for (const item of pending) out.push(item.match);
  return state.accepted >= limit;
}

function flushReady(pending: PendingMatch[], out: WorkspaceGrepMatch[]): void {
  while (pending[0]?.remaining === 0) {
    const item = pending.shift();
    if (item !== undefined) out.push(item.match);
  }
}

// Decode a whole file's bytes and yield 1-indexed lines. Mirrors the
// streaming decoder's framing exactly: a trailing fragment with no
// newline is still a line, and an empty file yields nothing.
function* splitLines(bytes: Uint8Array): Iterable<NumberedLine> {
  if (bytes.byteLength === 0) return;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let line = 1;
  let start = 0;
  let newline = text.indexOf("\n");
  while (newline !== -1) {
    yield { line, text: text.slice(start, newline) };
    line += 1;
    start = newline + 1;
    newline = text.indexOf("\n", start);
  }
  if (start < text.length) yield { line, text: text.slice(start) };
}

async function* readLines(db: Database, target: ScanTarget): AsyncIterable<NumberedLine> {
  // Traversal-produced targets carry the inode and size the walk
  // already read, so the bytes can be pulled straight from the chunk
  // store. Re-resolving the path here cost one recursive-CTE statement
  // per file, which is the bulk of a recursive grep's SQL.
  if (target.inode !== undefined && target.size !== undefined) {
    const bytes = readCommittedFileByInode(db, target.inode, target.size, target.path);
    yield* splitLines(bytes);
    return;
  }

  const stream = await readFile(db, target.path);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let tail = "";
  let line = 1;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value === undefined) continue;
      tail += decoder.decode(value, { stream: true });
      let newline = tail.indexOf("\n");
      while (newline !== -1) {
        yield { line, text: tail.slice(0, newline) };
        line += 1;
        tail = tail.slice(newline + 1);
        newline = tail.indexOf("\n");
      }
    }
    tail += decoder.decode();
    if (tail.length > 0) yield { line, text: tail };
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
}
