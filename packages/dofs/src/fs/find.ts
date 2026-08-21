import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";

export interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

// Same as WorkspaceFoundEntry but carries the inode the traversal
// already read. Internal callers that need to touch the node's
// content (grep) use this to skip a redundant path re-resolve.
export interface FoundEntryWithInode extends WorkspaceFoundEntry {
  inode: number;
  /** Cached vfs_nodes.size; 0 for directories. */
  size: number;
}

export interface FindOptions {
  /** Maximum matching entries to return. */
  limit?: number;
  /** Matching entries to skip in traversal order. */
  offset?: number;
  /**
   * Whole-segment names to skip. A directory whose name matches is
   * never descended into, so its subtree costs nothing; a file whose
   * name matches is not yielded. Matching is exact per path segment —
   * "node_modules" does not match "node_modules_extra".
   *
   * Pruning happens during descent rather than filtering emitted
   * entries, which is the whole point: excluding node_modules has to
   * avoid walking it, not walk it and discard the results.
   */
  exclude?: string[];
}

interface ChildRow {
  name: string;
  child_inode: number;
  type: "file" | "dir";
  size: number;
}

interface WalkStart {
  inode: number;
  path: string;
  prefix: string;
  regex: RegExp | undefined;
  exclude: ReadonlySet<string>;
}

const CHILD_PAGE_SIZE = 128;

export function find(
  db: Database,
  directory: string,
  pattern?: string,
  options: FindOptions = {},
): WorkspaceFoundEntry[] {
  const start = prepareWalk(db, directory, pattern, options.exclude);
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("find limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("find offset must be a non-negative safe integer");
  }
  if (limit === 0) return [];

  const out: WorkspaceFoundEntry[] = [];
  let seen = 0;
  for (const entry of walk(db, start.inode, start.path, start.prefix, start.regex, start.exclude)) {
    if (seen >= offset) {
      // The walk carries the inode for internal callers; the public
      // find() contract is {path, type} only.
      out.push({ path: entry.path, type: entry.type });
      if (out.length >= limit) break;
    }
    seen += 1;
  }
  return out;
}

export function* iterateFoundEntries(
  db: Database,
  directory: string,
  pattern?: string,
  exclude?: string[],
): IterableIterator<FoundEntryWithInode> {
  const start = prepareWalk(db, directory, pattern, exclude);
  yield* walk(db, start.inode, start.path, start.prefix, start.regex, start.exclude);
}

function prepareWalk(
  db: Database,
  directory: string,
  pattern: string | undefined,
  exclude: string[] | undefined,
): WalkStart {
  const { path: canonical } = canonicalizePath(directory);
  const node = resolveInode(db, canonical);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
  }
  if (node.type !== "dir") {
    throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
  }

  // An empty pattern is equivalent to no pattern: walk and return
  // everything rather than compiling it into `^$`, which would match
  // only empty relative paths and yield no results.
  const regex = pattern ? compileGlob(pattern) : undefined;
  return {
    inode: node.inode,
    path: canonical,
    prefix: canonical === "/" ? "/" : `${canonical}/`,
    regex,
    exclude: exclude === undefined || exclude.length === 0 ? EMPTY_EXCLUDE : new Set(exclude),
  };
}

const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>();

function* walk(
  db: Database,
  parentInode: number,
  parentPath: string,
  prefix: string,
  regex: RegExp | undefined,
  exclude: ReadonlySet<string>,
): IterableIterator<FoundEntryWithInode> {
  let afterName = "";
  while (true) {
    const children = readChildren(db, parentInode, afterName);
    if (children.length === 0) return;

    for (const child of children) {
      // Prune before doing anything else: an excluded directory is
      // neither yielded nor descended into, so its entire subtree
      // costs zero statements.
      if (exclude.size > 0 && exclude.has(child.name)) continue;
      const childPath = parentPath === "/" ? `/${child.name}` : `${parentPath}/${child.name}`;
      const relativePath = childPath.slice(prefix.length);
      if (regex === undefined || regex.test(relativePath)) {
        yield {
          path: childPath,
          type: child.type,
          inode: child.child_inode,
          size: child.size,
        };
      }
      if (child.type === "dir") {
        yield* walk(db, child.child_inode, childPath, prefix, regex, exclude);
      }
    }

    if (children.length < CHILD_PAGE_SIZE) return;
    afterName = children[children.length - 1].name;
  }
}

function readChildren(db: Database, parentInode: number, afterName: string): ChildRow[] {
  return db.all<ChildRow>(
    `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type, n.size AS size
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ? AND d.name > ?
      ORDER BY d.name
      LIMIT ?`,
    parentInode,
    afterName,
    CHILD_PAGE_SIZE,
  );
}

// Compile a simple glob into a regex. Supported:
//   *  matches any run of characters except '/'
//   ** matches any run of characters including '/'
//   ?  matches one character except '/'
// Anything else is a literal. Regex metacharacters in literals are
// escaped so '.' in '*.ts' doesn't match an arbitrary character.
function compileGlob(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // '**/' matches zero or more path segments. Without the slash, '**'
        // matches any run including slashes.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (REGEX_METACHARS.has(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

const REGEX_METACHARS = new Set([".", "+", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"]);
