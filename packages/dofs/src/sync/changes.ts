import { createHash } from "node:crypto";
import { resolveInode } from "../fs/resolve.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";

// Record a tombstone for a deleted path so the next push to the
// container learns the path is gone. Called by fs/rm inside the same
// transaction that bumped rev and removed the inode rows; the caller
// passes the post-bump rev value.
export function recordDelete(db: Database, rev: number, path: string): void {
  db.run("INSERT INTO vfs_changes (rev, path, op) VALUES (?, ?, 'delete')", rev, path);
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
function sha256(bytes: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(bytes);
  return new Uint8Array(hash.digest());
}

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
  | { kind: "delete"; rev: number; path: string };

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
    // separate manifest lookup. Inline files do not have chunk rows;
    // synthesize the single wire chunk from inline_data so sync still
    // ships their bytes. Empty files produce zero rows and size 0.
    const inline = db.one<{ inline_data: Uint8Array | null }>(
      "SELECT inline_data FROM vfs_nodes WHERE inode = ?",
      live.inode,
    )?.inline_data;
    const chunks =
      inline !== undefined && inline !== null
        ? inline.byteLength === 0
          ? []
          : [{ hash: sha256(inline), size: inline.byteLength }]
        : db.all<{ hash: Uint8Array; size: number }>(
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
  const tomb = db.one<{ rev: number; op: string }>(
    "SELECT rev, op FROM vfs_changes WHERE path = ? ORDER BY id DESC LIMIT 1",
    canonical,
  );
  if (tomb?.op === "delete") {
    return { kind: "delete", rev: tomb.rev, path: canonical };
  }
  return null;
}
