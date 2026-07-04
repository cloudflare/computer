import { canonicalizePath } from "../path.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

interface PathRow {
  path: string;
}

// Recursive CTE that materializes the file paths under one listing
// root. Files only (no directory entries) because that's the
// documented "flat list of file paths" semantics.
//
// The walk is seeded at the listing root's inode: each row is
// (inode, path, type), built by concatenating dirent names with '/'
// separators onto the seed path. Scoping the seed to the requested
// directory keeps the walk O(subtree) instead of O(whole tree).
const LS_QUERY = `
  WITH RECURSIVE walk(inode, path, type) AS (
    SELECT inode, ?, type FROM vfs_nodes WHERE inode = ?
    UNION ALL
    SELECT n.inode, w.path || '/' || d.name, n.type
      FROM walk w
      JOIN vfs_dirents d ON d.parent_inode = w.inode
      JOIN vfs_nodes n ON n.inode = d.child_inode
  )
  SELECT path FROM walk
   WHERE type = 'file'
   ORDER BY path
`;

// Walk dirents from the root to `parts` without following symlinks, so
// the seed matches the CTE's structural view: a symlink component has
// no dirents and thus lists nothing, and a missing or non-directory
// component resolves to null (an empty listing). Returns the root
// inode for an empty path.
function resolvePrefixInode(db: Database, parts: string[]): number | null {
  let inode = ROOT_INODE;
  for (const name of parts) {
    const child = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      inode,
      name,
    );
    if (child === undefined) return null;
    inode = child.child_inode;
  }
  return inode;
}

export function ls(db: Database, prefix: string): string[] {
  const { parts, path: canonical } = canonicalizePath(prefix);
  const inode = resolvePrefixInode(db, parts);
  if (inode === null) return [];
  // Root contributes the empty string so its children start with '/';
  // a non-root prefix seeds its own path so descendants read as
  // absolute paths.
  const seedPath = canonical === "/" ? "" : canonical;
  return db.all<PathRow>(LS_QUERY, seedPath, inode).map((row) => row.path);
}
