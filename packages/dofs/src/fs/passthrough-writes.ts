// Writes whose own walk follows no links, symlink and link, fail
// with ENOTDIR at a link in the parent path. When that link leads into
// a passthrough root, the write is one into a read-only mount and
// fails as one, with EROFS.

import type { Database } from "../storage";
import { asReadOnly, hasPassthroughMounts, isPassthroughUnsupported } from "./passthrough-registry";
import { resolveInode } from "./resolve";

export function assertParentNotInPassthrough(db: Database, parentPath: string): void {
  if (!hasPassthroughMounts(db) || parentPath === "/") return;
  try {
    resolveInode(db, parentPath);
  } catch (error) {
    // Any other failure is the write's own walk to report.
    if (isPassthroughUnsupported(error)) throw asReadOnly(error);
  }
}
