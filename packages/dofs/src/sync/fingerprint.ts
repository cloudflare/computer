import { createHash } from "node:crypto";

import type { Database } from "../storage";
import { computeManifestHash } from "./manifests";

// A version fingerprint names what a delete would destroy: the node's
// type, its permission bits, and its content (a file's manifest hash,
// a symlink's target). Directories are described by mode alone; their
// content is their children, which carry fingerprints of their own.
//
// Revs and mtimes are left out on purpose. Two peers holding the same
// version stamp it with unrelated revs and may disagree on mtime, and
// neither is something a delete loses.
//
// Tombstones record the fingerprint of the version they removed
// (`vfs_changes.prior`, `ChangeEntry.prior` on the wire), so a receiver
// can tell "the sender deleted exactly what I hold" from "the sender
// deleted an older version than mine". The value is opaque: compare it
// for equality only.
export type VersionShape =
  | { type: "file"; mode: number; manifest: Uint8Array }
  | { type: "symlink"; mode: number; target: string }
  | { type: "dir"; mode: number };

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fingerprintVersion(version: VersionShape): string {
  const mode = version.mode & 0o7777;
  const parts =
    version.type === "file"
      ? ["file", mode, toHex(version.manifest)]
      : version.type === "symlink"
        ? ["symlink", mode, version.target]
        : ["dir", mode];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// Fingerprint the live node at `inode`, or undefined if it is gone.
// A file's manifest hash comes from vfs_nodes when the write path
// recorded one and is recomputed from its chunk rows otherwise; both
// hash the same canonical chunk list, so they agree.
export function versionFingerprint(db: Database, inode: number): string | undefined {
  const node = db.one<{
    type: "file" | "dir" | "symlink";
    mode: number;
    manifest_hash: Uint8Array | null;
    link_target: string | null;
  }>("SELECT type, mode, manifest_hash, link_target FROM vfs_nodes WHERE inode = ?", inode);
  if (node === undefined) return undefined;
  if (node.type === "dir") return fingerprintVersion({ type: "dir", mode: node.mode });
  if (node.type === "symlink") {
    return fingerprintVersion({ type: "symlink", mode: node.mode, target: node.link_target ?? "" });
  }
  const manifest =
    node.manifest_hash ??
    computeManifestHash(
      db.all<{ hash: Uint8Array; size: number }>(
        "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
        inode,
      ),
    );
  return fingerprintVersion({ type: "file", mode: node.mode, manifest });
}
