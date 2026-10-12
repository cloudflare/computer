import { resolveInode } from "../fs/resolve.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";

// Record a tombstone for a deleted path so the next push to the
// container learns the path is gone. Called by fs/rm and fs/rename
// inside the same transaction that bumped rev and removed the inode
// rows; the caller passes the post-bump rev value and, when it has it,
// the fingerprint of the version it removed (sync/fingerprint.ts).
export function recordDelete(db: Database, rev: number, path: string, prior?: string): void {
  db.run(
    "INSERT INTO vfs_changes (rev, path, op, prior) VALUES (?, ?, 'delete', ?)",
    rev,
    path,
    prior ?? null,
  );
}

// One row of the sync wire. The DO pushes these to the container
// and the container fetches them back. Bytes are never inline:
// file entries carry chunk hashes and the receiver does its own
// hasObjects probe + fetchObjects pull for the bytes it lacks.
//
// `rev` is the sender's currentRev at the moment this entry was
// stamped — vfs_nodes.rev for live mutations, vfs_changes.rev for
// tombstones. The puller uses it as a per-entry cursor so it can
// advance fetchRev per committed batch instead of waiting for the
// whole stream to drain.
export type ChangeEntry =
  | {
      kind: "file";
      rev: number;
      path: string;
      mode: number;
      mtime: number;
      size: number;
      chunks: { hash: Uint8Array; size: number }[];
    }
  | { kind: "dir"; rev: number; path: string; mode: number; mtime: number }
  | {
      kind: "symlink";
      rev: number;
      path: string;
      target: string;
      mode: number;
      mtime: number;
    }
  | {
      kind: "delete";
      rev: number;
      path: string;
      // Fingerprint of the version the sender removed. Absent from
      // peers that predate it and from bulk rename tombstones; a
      // receiver then decides by its push cursor alone.
      prior?: string;
    };

// Read the current state of `path` and turn it into a wire entry.
// Returns null when the path was never touched (no live inode and no
// tombstone in vfs_changes). Live inodes win over tombstones, which
// handles the delete-then-recreate case correctly.
//
// Symlinks are returned as symlink entries; we never follow them on
// the sync wire. Callers that want "the file the link points at"
// resolve it themselves after applying the symlink entry.
export function materialiseChange(db: Database, path: string): ChangeEntry | null {
  const canonical = canonicalizePath(path).path;
  const live = resolveInode(db, canonical, { followSymlinks: false });
  if (live !== null) {
    // Read the rev stamped on this inode. Used as the per-entry
    // cursor on the sync wire; coalesceChanges yields entries in
    // ascending rev order so the puller can checkpoint per batch.
    const revRow = db.one<{ rev: number }>("SELECT rev FROM vfs_nodes WHERE inode = ?", live.inode);
    const rev = revRow?.rev ?? 0;
    if (live.type === "dir") {
      return { kind: "dir", rev, path: canonical, mode: live.mode, mtime: live.mtime };
    }
    if (live.type === "symlink") {
      return {
        kind: "symlink",
        rev,
        path: canonical,
        target: live.linkTarget ?? "",
        mode: live.mode,
        mtime: live.mtime,
      };
    }
    // file: collect chunk rows in index order. Each row carries hash
    // and size so the receiver can probe hasObjects without a
    // separate manifest lookup. An empty file has zero chunk rows
    // and reports size 0.
    const chunks = db.all<{ hash: Uint8Array; size: number }>(
      "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      live.inode,
    );
    let size = 0;
    for (const c of chunks) size += c.size;
    return {
      kind: "file",
      rev,
      path: canonical,
      mode: live.mode,
      mtime: live.mtime,
      size,
      chunks,
    };
  }
  // No live inode — check for a tombstone. The last row wins if the
  // path was deleted and never recreated; an indexed scan by path is
  // cheap because vfs_changes is bounded by the watermark window.
  const tomb = db.one<{ rev: number; op: string; prior: string | null }>(
    "SELECT rev, op, prior FROM vfs_changes WHERE path = ? ORDER BY id DESC LIMIT 1",
    canonical,
  );
  if (tomb?.op === "delete") {
    return tomb.prior === null
      ? { kind: "delete", rev: tomb.rev, path: canonical }
      : { kind: "delete", rev: tomb.rev, path: canonical, prior: tomb.prior };
  }
  return null;
}
