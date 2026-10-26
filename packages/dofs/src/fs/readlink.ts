import { createWorkspaceError } from "../errors";
import type { Database } from "../storage";
import { resolveInode } from "./resolve";

// Return the stored target of a symlink. Does not follow the link.
// Mirrors POSIX semantics: ENOENT for a missing path, EINVAL when
// the path resolves to something that isn't a symlink.
export function readlink(db: Database, path: string): string {
  const node = resolveInode(db, path, { followSymlinks: false });
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
  }
  if (node.type !== "symlink" || node.linkTarget === undefined) {
    throw createWorkspaceError("EINVAL", `not a symlink: ${path}`, path);
  }
  return node.linkTarget;
}
