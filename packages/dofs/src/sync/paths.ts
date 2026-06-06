import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

// Walk vfs_dirents from `inode` up to ROOT_INODE, gathering the path
// segments along the way. Returns null when the inode is unreachable.
export function pathOf(db: Database, inode: number): string | null {
  if (inode === ROOT_INODE) return "/";
  const segments: string[] = [];
  let current = inode;
  // Bound the walk: a million levels deep is well past any real FS;
  // anything beyond that is corruption and should not loop forever.
  for (let i = 0; i < 1_000_000; i++) {
    const row = db.one<{ parent_inode: number; name: string }>(
      "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
      current,
    );
    if (row === undefined) return null;
    segments.push(row.name);
    if (row.parent_inode === ROOT_INODE) {
      segments.reverse();
      return `/${segments.join("/")}`;
    }
    current = row.parent_inode;
  }
  return null;
}

// Every path that currently names `inode`. A file may carry several
// hardlink names; pathOf collapses them to one arbitrary name, which
// is wrong for the change stream — every name has to reach the wire so
// the receiver materialises each. Directories cannot be hardlinked, so
// each parent walk is unambiguous.
export function pathsOf(db: Database, inode: number): string[] {
  if (inode === ROOT_INODE) return ["/"];
  const dirents = db.all<{ parent_inode: number; name: string }>(
    "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
    inode,
  );
  const paths: string[] = [];
  for (const { parent_inode, name } of dirents) {
    const parent = pathOf(db, parent_inode);
    if (parent === null) continue;
    paths.push(parent === "/" ? `/${name}` : `${parent}/${name}`);
  }
  return paths;
}
