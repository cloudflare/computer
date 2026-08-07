import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";

export interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}

interface ChildRow {
  name: string;
  child_inode: number;
  type: "file" | "dir";
}

export function find(db: Database, directory: string, pattern?: string): WorkspaceFoundEntry[] {
  const { path: canonical } = canonicalizePath(directory);
  const node = resolveInode(db, canonical);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
  }
  if (node.type !== "dir") {
    throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
  }

  const out: WorkspaceFoundEntry[] = [];
  // An empty pattern is equivalent to no pattern: walk and return
  // everything rather than compiling it into `^$`, which would match
  // only empty relative paths and yield no results.
  const regex = pattern ? compileGlob(pattern) : undefined;

  walk(db, node.inode, canonical, out);

  if (regex === undefined) {
    return out;
  }
  // Glob matches against the path relative to the start directory.
  const prefix = canonical === "/" ? "/" : `${canonical}/`;
  return out.filter((entry) => {
    if (!entry.path.startsWith(prefix)) return false;
    const rel = entry.path.slice(prefix.length);
    return regex.test(rel);
  });
}

function walk(db: Database, parentInode: number, parentPath: string, out: WorkspaceFoundEntry[]) {
  const children = db.all<ChildRow>(
    `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name`,
    parentInode,
  );
  for (const child of children) {
    const childPath = parentPath === "/" ? `/${child.name}` : `${parentPath}/${child.name}`;
    out.push({ path: childPath, type: child.type });
    if (child.type === "dir") {
      walk(db, child.child_inode, childPath, out);
    }
  }
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
