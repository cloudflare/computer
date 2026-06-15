import { mkdir } from "../fs/mkdir.js";
import { readOnlyRootFor } from "../fs/mount-guard.js";
import { resolveInode } from "../fs/resolve.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { writeFile, writeFileSync } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { computeManifestHash } from "./manifests.js";
import { readWatermark, writeWatermark } from "./watermarks.js";

// One container-side change that landed under a read-only mount and
// was therefore skipped rather than applied. Callers (the workspace
// pull surface, the shell exec bracket) surface these so the user
// learns the mount stayed authoritative.
export interface SkippedEntry {
  // Absolute VFS path the change targeted.
  path: string;
  // Mount root that owns the path (the one whose mode is
  // read-only). Lets callers group skipped entries by mount.
  mountRoot: string;
  // 'write' covers file / dir / symlink create-or-update; 'delete'
  // covers tombstones. The single field is enough for callers to
  // decide messaging.
  op: "write" | "delete";
  // Open shape: future skip reasons can join this union without
  // breaking callers that match on 'read-only' today.
  reason: "read-only";
}

// Return shape of applyChanges / applyChangesSync. Existing callers
// that only wanted a count read `result.applied`; new callers can
// surface `result.skipped`.
export interface ApplyResult {
  // Entries written through writeFile / mkdir / symlink / rm.
  applied: number;
  // Entries dropped because they targeted a read-only mount root.
  // Empty when no such mounts are registered or the stream stayed
  // clear of them.
  skipped: SkippedEntry[];
}

export interface ApplyOptions {
  // Soft cap on bytes written per transactionSync batch. Default 64
  // MiB; matches docs/02_sync_protocol.md. The cap is advisory: a
  // single large file is always one batch.
  maxBytesPerBatch?: number;
  // Soft cap on entries per batch. Default 1024 paths.
  maxPathsPerBatch?: number;
  // After the stream drains, advance fetchRev to this value if it's
  // higher than the current persisted value. Callers pass the
  // sender's currentRev so the next pull resumes from the right
  // cursor. Never regresses the watermark.
  advanceFetchRev?: number;
  // Where the entries came from. 'local' (default) treats the apply
  // path like any other mutation: writeFile/mkdir/etc bump
  // vfs_meta.rev and the push loop later ships those new revs
  // upstream. 'upstream' is informational: the apply still bumps
  // rev so readers see fresh data, and the next pushOnce ships
  // those rev bumps back to the sender. Loop convergence is the
  // receiver's job — the apply path on the original sender uses
  // alreadyApplied() to drop the redundant entries without bumping
  // rev further, bounding the echo at one extra round trip per
  // upstream apply.
  source?: "local" | "upstream";
  // Backend id whose watermark row this apply should touch. The
  // DO hosts independent sync cursors per backend; threading the
  // id through here keeps a pull from backend A from bumping
  // backend B's pushRev. Defaults to the dofs `default` slot,
  // which is fine for the container backend the package shipped
  // with first.
  backend?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PATHS = 1024;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// Drive a ChangeEntry stream against `db`, batching writes so peak
// memory stays bounded and a crash mid-apply leaves the DB in a
// consistent state. Each batch runs inside a single transactionSync
// from the underlying FS helpers — mkdir, writeFile, symlink,
// rm all wrap their own transactionSync, so a batch is in practice
// a sequence of independently-committed mutations rather than one
// fat transaction. The bounded-batch contract still holds because
// fetchRev only advances after the stream drains.
//
// `objects` is a hash-keyed map of chunk bytes the sender shipped
// via pushObjects / fetchObjects. File entries reassemble their
// chunks from this map; missing entries throw.
export async function applyChanges(
  db: Database,
  entries: Iterable<ChangeEntry> | AsyncIterable<ChangeEntry>,
  objects: Map<string, Uint8Array>,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES;
  const maxPaths = options.maxPathsPerBatch ?? DEFAULT_MAX_PATHS;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  let applied = 0;
  const skipped: SkippedEntry[] = [];
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for await (const entry of entries) {
    // Idempotent skip: if the entry already matches the local
    // state, drop it on the floor. The check is what stops a
    // pull from bumping vfs_meta.rev for entries that are
    // already in place, which in turn stops the next push from
    // re-shipping them.
    if (options.source === "upstream" && entry.kind !== "delete") {
      if (alreadyApplied(db, entry)) continue;
    }
    // Read-only mount guard. Entries under a registered read-only
    // mount root are surfaced via the return value and not applied.
    // The owning workspace's surface (Workspace.pull, exec()) folds
    // these into its own return so callers see what stayed
    // authoritative on the mount.
    const blockingRoot = readOnlyRootFor(db, entry.path);
    if (blockingRoot !== undefined) {
      skipped.push({
        path: entry.path,
        mountRoot: blockingRoot,
        op: entry.kind === "delete" ? "delete" : "write",
        reason: "read-only",
      });
      continue;
    }
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Already gone is fine — idempotent apply.
      }
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "dir") {
      mkdir(db, entry.path, { mode: entry.mode, recursive: true }, () => entry.mtime);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "symlink") {
      symlink(db, entry.target, entry.path, () => entry.mtime);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    // file: assemble chunk bytes. First check the in-memory map
    // (the streaming hand-off); fall back to vfs_blob_bytes (the
    // staged-via-pushObjects path).
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const c of entry.chunks) {
      const k = hex(c.hash);
      let bytes = objects.get(k);
      if (bytes === undefined) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          c.hash,
        );
        bytes = row?.bytes;
      }
      if (bytes === undefined) {
        throw new Error(`applyChanges: missing object ${k} for ${entry.path}`);
      }
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    await writeFile(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    applied++;
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
  }

  // Advance fetchRev only after the stream drains so a crash
  // mid-apply leaves the watermark behind and the next pull
  // re-fetches anything not yet committed.
  if (options.advanceFetchRev !== undefined) {
    const current = readWatermark(db, "fetchRev", options.backend);
    if (options.advanceFetchRev > current) {
      writeWatermark(db, "fetchRev", options.advanceFetchRev, options.backend);
    }
  }

  // Loopback suppression used to advance pushRev locally after an
  // upstream apply so the next push tick wouldn't re-ship the rev
  // bumps the apply produced. That optimization is unsound: it
  // moves the *local* pushRev past entries the remote does not
  // know we have shipped, while the remote's fetchRev (echoed back
  // as appliedPushRev on every fetchChanges) stays where it was.
  // The cross-side invariant check in pullOnce then trips on the
  // very next pull and the post-drain pullOnce in the exec bracket
  // swallows the error, leaving every subsequent container-side
  // write invisible to the host until something reconciles.
  //
  // The bounded "redundant round-trip" the old comment promised is
  // still bounded, and the receiver's alreadyApplied() check still
  // suppresses the entries on the next pushOnce. We just pay one
  // extra push per upstream apply to keep the two sides in lockstep.
  return { applied, skipped };
}

// Synchronous variant of applyChanges. Same semantics; takes an
// in-memory entry array instead of an iterable. Used on the push
// receiver so the whole batch can run inside a single transactionSync
// and a mid-stream failure rolls back every prior entry.
//
// Stays separate from applyChanges so the streaming pull path
// (which can't hold a sync transaction across network I/O) keeps
// its async semantics.
export function applyChangesSync(
  db: Database,
  entries: readonly ChangeEntry[],
  objects: Map<string, Uint8Array>,
  options: ApplyOptions = {},
): ApplyResult {
  const maxBytes = options.maxBytesPerBatch ?? DEFAULT_MAX_BYTES;
  const maxPaths = options.maxPathsPerBatch ?? DEFAULT_MAX_PATHS;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  let applied = 0;
  const skipped: SkippedEntry[] = [];
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for (const entry of entries) {
    if (options.source === "upstream" && entry.kind !== "delete") {
      if (alreadyApplied(db, entry)) continue;
    }
    const blockingRoot = readOnlyRootFor(db, entry.path);
    if (blockingRoot !== undefined) {
      skipped.push({
        path: entry.path,
        mountRoot: blockingRoot,
        op: entry.kind === "delete" ? "delete" : "write",
        reason: "read-only",
      });
      continue;
    }
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Already gone is fine — idempotent apply.
      }
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "dir") {
      mkdir(db, entry.path, { mode: entry.mode, recursive: true }, () => entry.mtime);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "symlink") {
      symlink(db, entry.target, entry.path, () => entry.mtime);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const c of entry.chunks) {
      const k = hex(c.hash);
      let bytes = objects.get(k);
      if (bytes === undefined) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          c.hash,
        );
        bytes = row?.bytes;
      }
      if (bytes === undefined) {
        throw new Error(`applyChanges: missing object ${k} for ${entry.path}`);
      }
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    writeFileSync(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    applied++;
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
  }

  if (options.advanceFetchRev !== undefined) {
    const current = readWatermark(db, "fetchRev", options.backend);
    if (options.advanceFetchRev > current) {
      writeWatermark(db, "fetchRev", options.advanceFetchRev, options.backend);
    }
  }

  // See applyChanges() for why pushRev no longer advances locally
  // on upstream applies. The receiver's alreadyApplied() check
  // suppresses the redundant entries on the next pushOnce; one
  // extra push per apply keeps the cross-side invariant intact.

  return { applied, skipped };
}

// Compare an entry against the local node graph. Returns true when
// the entry would be a no-op apply: the manifest hash (files),
// mode + symlink target (symlinks), or mode (dirs) already matches.
// We deliberately skip mtime comparison — mtime is metadata
// the source decides on, and re-applying it would still bump the
// local rev counter for nothing. Receivers see eventual mtime
// drift between peers; the wire stays quiet.
function alreadyApplied(db: Database, entry: Exclude<ChangeEntry, { kind: "delete" }>): boolean {
  const live = resolveInode(db, entry.path, { followSymlinks: false });
  if (live === null) return false;

  if (entry.kind === "file") {
    if (live.type !== "file") return false;
    const row = db.one<{ manifest_hash: Uint8Array | null }>(
      "SELECT manifest_hash FROM vfs_nodes WHERE inode = ?",
      live.inode,
    );
    if (!row?.manifest_hash) return false;
    const wanted = computeManifestHash(entry.chunks);
    return uint8Equal(row.manifest_hash, wanted);
  }
  if (entry.kind === "dir") {
    return live.type === "dir" && (live.mode & 0o7777) === (entry.mode & 0o7777);
  }
  // symlink
  return (
    live.type === "symlink" &&
    live.linkTarget === entry.target &&
    (live.mode & 0o7777) === (entry.mode & 0o7777)
  );
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
