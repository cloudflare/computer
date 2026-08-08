import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";

export interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

export interface FindOptions {
  /** Maximum matching entries to return. */
  limit?: number;
  /** Matching entries to skip in traversal order. */
  offset?: number;
}

interface ChildRow {
  name: string;
  child_inode: number;
  type: "file" | "dir";
}

interface WalkState {
  seen: number;
  offset: number;
  limit: number;
  out: WorkspaceFoundEntry[];
}

const CHILD_PAGE_SIZE = 128;

export function find(
  db: Database,
  directory: string,
  pattern?: string,
  options: FindOptions = {},
): WorkspaceFoundEntry[] {
  const { path: canonical } = canonicalizePath(directory);
  const node = resolveInode(db, canonical);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
  }
  if (node.type !== "dir") {
    throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
  }

  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("find limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("find offset must be a non-negative safe integer");
  }
  if (limit === 0) return [];

  // An empty pattern is equivalent to no pattern: walk and return
  // everything rather than compiling it into `^$`, which would match
  // only empty relative paths and yield no results.
  const regex = pattern ? compileGlob(pattern) : undefined;
  const prefix = canonical === "/" ? "/" : `${canonical}/`;
  const state: WalkState = { seen: 0, offset, limit, out: [] };
  walk(db, node.inode, canonical, prefix, regex, state);
  return state.out;
}

function walk(
  db: Database,
  parentInode: number,
  parentPath: string,
  prefix: string,
  regex: RegExp | undefined,
  state: WalkState,
): boolean {
  let afterName = "";
  while (true) {
    const children = readChildren(db, parentInode, afterName);
    if (children.length === 0) return false;

    for (const child of children) {
      const childPath = parentPath === "/" ? `/${child.name}` : `${parentPath}/${child.name}`;
      const relativePath = childPath.slice(prefix.length);
      if (regex === undefined || regex.test(relativePath)) {
        if (state.seen >= state.offset) {
          state.out.push({ path: childPath, type: child.type });
          if (state.out.length >= state.limit) return true;
        }
        state.seen += 1;
      }
      if (child.type === "dir" && walk(db, child.child_inode, childPath, prefix, regex, state)) {
        return true;
      }
    }

    if (children.length < CHILD_PAGE_SIZE) return false;
    afterName = children[children.length - 1].name;
  }
}

function readChildren(db: Database, parentInode: number, afterName: string): ChildRow[] {
  return db.all<ChildRow>(
    `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
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
