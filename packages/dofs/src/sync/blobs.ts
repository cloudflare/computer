import { clearBlobCache } from "../fs/blobCache.js";
import type { Database } from "../storage.js";

// Stage a chunk directly into vfs_blobs + vfs_blob_bytes without
// creating a node or a manifest. The receiver-side push path uses
// this to land bytes the sender shipped via pushObjects so a
// subsequent applyChanges call can find them by hash.
//
// Idempotent: a second call with the same hash refreshes
// last_seen so the bytes don't get reaped by an interleaved gc.
// Conflict updates also repair incomplete or size-mismatched rows
// left by an interrupted or corrupt write.
//
// Callers are expected to have verified that hash === sha256(bytes)
// before calling. The function trusts the caller; a mismatched
// pair would silently land under the wrong key.
export function stageBlob(db: Database, hash: Uint8Array, bytes: Uint8Array, now: number): void {
  db.transactionSync(() => {
    db.run(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size = excluded.size, last_seen = excluded.last_seen",
      hash,
      bytes.byteLength,
      now,
    );
    db.run(
      "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes",
      hash,
      bytes,
    );
  });
  clearBlobCache(db);
}
