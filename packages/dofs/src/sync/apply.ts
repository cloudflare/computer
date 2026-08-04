import { mkdir } from "../fs/mkdir.js";
import { readOnlyRootFor } from "../fs/mount-guard.js";
import { resolveInode } from "../fs/resolve.js";
import { invalidateResolveSubtree } from "../fs/resolveCache.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { unlinkDirent } from "../fs/unlink.js";
import { writeFile, writeFileSync } from "../fs/writeFile.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { computeManifestHash } from "./manifests.js";

// One incoming change that was refused rather than applied. Callers
// (the workspace pull surface, the shell exec bracket) surface these
// so the user learns what did not land.
//
// Discriminated on `reason` because the two refusals carry different
// information. A read-only mount names the mount that owns the path,
// which lets a caller group entries by mount. A missing write
// capability has no mount to name: the apply itself had no write
// access, so every entry is refused wherever it pointed.
export type SkippedEntry = SkippedByMount | SkippedWithoutWriteAccess;

// Common fields. Split out so both members stay in step.
interface SkippedEntryBase {
  // Absolute VFS path the change targeted.
  path: string;
  // 'write' covers file / dir / symlink create-or-update; 'delete'
  // covers tombstones. The single field is enough for callers to
  // decide messaging.
  op: "write" | "delete";
}

// The path falls under a registered read-only mount root.
export interface SkippedByMount extends SkippedEntryBase {
  reason: "read-only";
  // Mount root that owns the path (the one whose mode is
  // read-only). Lets callers group skipped entries by mount.
  mountRoot: string;
}

// The apply ran without write access, so nothing was applied at all.
// This is the after-the-fact half of a read-only command: the sender
// has already written to its own copy of the files, and the changes
// stop here on the way in.
export interface SkippedWithoutWriteAccess extends SkippedEntryBase {
  reason: "no-write-access";
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
  // Write access for this apply. Defaults to true. Pass false and
  // nothing is applied: every entry comes back in `skipped` with
  // reason 'no-write-access'.
  //
  // This is how a command that ran without write access is enforced
  // for a backend that keeps its own copy of the files. The command
  // wrote to that copy already, so refusing here is after the fact
  // rather than preventive — the copies diverge, and the skipped
  // entries are what tells the caller so. A backend that writes this
  // store directly gets the preventive version instead, through a
  // filesystem handle built without write access.
  writable?: boolean;
}

// Shape one refused entry for an apply that has no write access.
// Shared by both apply variants so they cannot drift.
function refusedWithoutWriteAccess(entry: ChangeEntry): SkippedWithoutWriteAccess {
  return {
    path: entry.path,
    op: entry.kind === "delete" ? "delete" : "write",
    reason: "no-write-access",
  };
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PATHS = 1024;

type NodeType = "file" | "dir" | "symlink";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function removeReplaceableFinalEntry(
  db: Database,
  path: string,
  incomingKind: "file" | "symlink",
): void {
  const existing = resolveInode(db, path, { followSymlinks: false });
  if (existing === null) return;
  if (incomingKind === "file" && existing.type === "file") return;

  removeInodeTreeAtPath(db, path, existing.inode, existing.type);
}

// Structural conflict cleanup for upstream applies. This removes
// the local shape without recording tombstones because the incoming
// entry is the authoritative state for this path.
function removeInodeTreeAtPath(db: Database, path: string, inode: number, type: NodeType): void {
  // Structural subtree removal that bypasses rm() and calls unlinkDirent
  // directly, so it must drop cached resolutions itself. One subtree
  // drop at the root covers every descendant the walk unlinks.
  // Canonicalize to the exact key readers cache under (every other hook
  // already passes a canonical path; this one takes an entry path).
  invalidateResolveSubtree(db, canonicalizePath(path).path);
  const root = direntForPath(db, path, inode);
  const stack: Array<{
    path: string;
    parentInode: number;
    name: string;
    inode: number;
    type: NodeType;
    expanded: boolean;
  }> = [
    {
      path,
      parentInode: root.parentInode,
      name: root.name,
      inode,
      type,
      expanded: false,
    },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    if (current.type === "dir" && !current.expanded) {
      const children = db.all<{ name: string; child_inode: number; type: NodeType }>(
        `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
           FROM vfs_dirents d
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE d.parent_inode = ?`,
        current.inode,
      );
      stack.push({ ...current, expanded: true });
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        const childPath = current.path === "/" ? `/${child.name}` : `${current.path}/${child.name}`;
        stack.push({
          path: childPath,
          parentInode: current.inode,
          name: child.name,
          inode: child.child_inode,
          type: child.type,
          expanded: false,
        });
      }
      continue;
    }

    // Unlink this one name and reap the inode only when its last link
    // disappears, so a sibling hardlink (inside or outside the subtree)
    // keeps the file alive. (parent, name) is unique, so this removes
    // exactly the dirent the walk is visiting.
    unlinkDirent(db, current.parentInode, current.name, current.inode, current.type);
  }
}

function direntForPath(
  db: Database,
  path: string,
  inode: number,
): { parentInode: number; name: string } {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw new Error(`applyChanges: cannot structurally replace root ${canonical}`);
  }
  const name = parts[parts.length - 1];
  const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
  const parent = resolveInode(db, parentPath, { followSymlinks: false });
  if (parent === null || parent.type !== "dir") {
    throw new Error(`applyChanges: parent missing for structural replacement ${canonical}`);
  }
  const child = db.scalar<number>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
    parent.inode,
    name,
  );
  if (child !== inode) {
    throw new Error(`applyChanges: dirent mismatch for structural replacement ${canonical}`);
  }
  return { parentInode: parent.inode, name };
}

function applyDirectoryEntry(db: Database, entry: Extract<ChangeEntry, { kind: "dir" }>): void {
  const mode = entry.mode & 0o7777;
  const existing = resolveInode(db, entry.path, { followSymlinks: false });
  if (existing === null) {
    mkdir(db, entry.path, { mode, recursive: true }, () => entry.mtime);
    return;
  }
  if (existing.type !== "dir") {
    removeInodeTreeAtPath(db, entry.path, existing.inode, existing.type);
    mkdir(db, entry.path, { mode, recursive: true }, () => entry.mtime);
    return;
  }

  db.transactionSync(() => {
    const rev = incrementRev(db);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ? WHERE inode = ?",
      mode,
      entry.mtime,
      rev,
      existing.inode,
    );
  });
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
  const writable = options.writable ?? true;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  let applied = 0;
  const skipped: SkippedEntry[] = [];
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for await (const entry of entries) {
    // Write capability. Checked ahead of everything else so a
    // read-only apply reports every entry it was handed rather than
    // quietly dropping the ones that happened to match local state.
    if (writable === false) {
      skipped.push(refusedWithoutWriteAccess(entry));
      continue;
    }
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
      applyDirectoryEntry(db, entry);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "symlink") {
      removeReplaceableFinalEntry(db, entry.path, "symlink");
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
    removeReplaceableFinalEntry(db, entry.path, "file");
    await writeFile(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    applied++;
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
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
  const writable = options.writable ?? true;

  let bytesInBatch = 0;
  let pathsInBatch = 0;
  let applied = 0;
  const skipped: SkippedEntry[] = [];
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for (const entry of entries) {
    if (writable === false) {
      skipped.push(refusedWithoutWriteAccess(entry));
      continue;
    }
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
      applyDirectoryEntry(db, entry);
      applied++;
      pathsInBatch++;
      if (pathsInBatch >= maxPaths) flush();
      continue;
    }
    if (entry.kind === "symlink") {
      removeReplaceableFinalEntry(db, entry.path, "symlink");
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
    removeReplaceableFinalEntry(db, entry.path, "file");
    writeFileSync(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
    applied++;
    bytesInBatch += total;
    pathsInBatch++;
    if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
  }

  // See applyChanges() for why pushRev no longer advances locally
  // on upstream applies. The receiver's alreadyApplied() check
  // suppresses the redundant entries on the next pushOnce; one
  // extra push per apply keeps the cross-side invariant intact.

  return { applied, skipped };
}

// Compare an entry against the local node graph. Returns true when
// the entry would be a no-op apply: the manifest hash (files), mode
// (dirs), or mode + symlink target (symlinks) already matches.
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
