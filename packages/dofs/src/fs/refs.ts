import type { Database } from "../storage";

// The only place that adds, replaces or drops a file's references to
// chunk blobs (vfs_chunks rows) and to its manifest
// (vfs_nodes.manifest_hash), and the only place that deletes a node
// row. Content is shared between files through dedupe and hardlinks,
// so the moment a reference goes is the moment to ask whether anything
// else still uses the content. Keeping every such statement here keeps
// that question in one place; fs/refs.source.test.ts fails the build
// when one appears anywhere else.

interface RefState {
  // Open reap deferral scopes. See openReapDeferral.
  deferDepth: number;
}

const states = new WeakMap<Database, RefState>();

function stateFor(db: Database): RefState {
  let state = states.get(db);
  if (state === undefined) {
    state = { deferDepth: 0 };
    states.set(db, state);
  }
  return state;
}

// Hold off reclaiming content until close(). Sync apply removes and
// links in separate transactions: a rename arrives as a delete of the
// old path and a file at the new one, so the delete drops the last
// reference to content the next entry links. Inside the scope nothing
// is reclaimed, and close() on the last open scope catches up.
export function openReapDeferral(db: Database): { close(): void } {
  const state = stateFor(db);
  state.deferDepth++;
  let open = true;
  return {
    close() {
      if (!open) return;
      open = false;
      state.deferDepth--;
    },
  };
}

export function reapsDeferred(db: Database): boolean {
  return (states.get(db)?.deferDepth ?? 0) > 0;
}

export interface FileNodeFields {
  mode: number;
  mtime: number;
  rev: number;
  size: number;
}

// Point chunk `idx` of `inode` at a blob. The index must be free.
export function linkChunk(
  db: Database,
  inode: number,
  idx: number,
  hash: Uint8Array,
  size: number,
): void {
  db.run(
    "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
    inode,
    idx,
    hash,
    size,
  );
}

// Point chunk `idx` of `inode` at a new blob, replacing whatever was
// there. `previous` is the hash the caller already loaded for that
// index, or undefined when the index was past the old end of file.
export function replaceChunk(
  db: Database,
  inode: number,
  idx: number,
  hash: Uint8Array,
  size: number,
  _previous: Uint8Array | undefined,
): void {
  db.run(
    "INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
    inode,
    idx,
    hash,
    size,
  );
}

// Drop the chunks of `inode` from index `fromIdx` on, and return the
// hashes they pointed at.
export function dropChunks(db: Database, inode: number, fromIdx = 0): Uint8Array[] {
  return db
    .all<{ hash: Uint8Array }>(
      "DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ? RETURNING hash",
      inode,
      fromIdx,
    )
    .map((row) => row.hash);
}

// Write a file node's metadata together with its manifest. A null
// manifest means "not built yet"; sync rebuilds it on demand.
export function setNodeManifest(
  db: Database,
  inode: number,
  manifestHash: Uint8Array | null,
  fields: FileNodeFields,
): void {
  db.run(
    "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?",
    fields.mode,
    fields.mtime,
    fields.rev,
    fields.size,
    manifestHash,
    inode,
  );
}

// Delete a node row. Its chunks, if it is a file, must be dropped
// first.
export function deleteNode(db: Database, inode: number): void {
  db.run("DELETE FROM vfs_nodes WHERE inode = ?", inode);
}
