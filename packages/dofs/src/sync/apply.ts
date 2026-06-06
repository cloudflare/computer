import { mkdir } from "../fs/mkdir.js";
import { readOnlyRootFor } from "../fs/mount-guard.js";
import { resolveInode } from "../fs/resolve.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { unlinkDirent } from "../fs/unlink.js";
import { writeFile, writeFileSync } from "../fs/writeFile.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { computeManifestHash } from "./manifests.js";
import { currentRev, readWatermark, writeWatermark } from "./watermarks.js";

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
  // Where the entries came from. 'local' (default) treats the apply
  // path like any other mutation: writeFile/mkdir/etc bump vfs_meta.rev
  // and the push loop later ships those new revs upstream. 'upstream'
  // means the entries came from a remote push or fetch; the apply
  // still bumps rev (so readers see fresh data) but we advance pushRev
  // to match, so the push loop knows everything in this range is
  // already on the wire. Without this flag, applying an upstream
  // entry would generate a push-back on the next tick and the two
  // sides would ping-pong forever.
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
  // Snapshot rev before we touch anything. Used by the loopback-
  // suppression at the bottom to decide whether it's safe to
  // advance pushRev past the entries this apply produced.
  const revBeforeApply = currentRev(db);
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

  // Loopback suppression: when this apply pass reflects entries
  // from upstream, the writeFile/mkdir/symlink/rm calls inside
  // bumped vfs_meta.rev. Without this advance, the next push tick
  // would see those rev bumps as fresh local changes and push them
  // back to upstream, which would apply them and bump again, and
  // so on.
  //
  // Subtle: we can only advance pushRev when it already covered
  // every rev that existed *before* this apply. If the caller had
  // unpushed local writes sitting between (existing, revBeforeApply],
  // advancing pushRev past them would strand them — the next
  // pushOnce would skip them as already-shipped. That was F1: a
  // pull whose entries were all idempotent-skipped still bumped
  // pushRev up to currentRev, masking local writes that hadn't
  // shipped yet.
  //
  // In the unsafe case we leave pushRev alone. The next pushOnce
  // drains both the unpushed locals and the apply's own bumps;
  // the receiver's alreadyApplied() check suppresses the latter.
  // Normal loopback suppression still catches the common case by
  // advancing pushRev after the upstream apply. When pending local
  // writes make that unsafe, the apply's rev bumps may be sent back
  // once, but the origin sees matching live state in alreadyApplied()
  // and drops them without another bump. That makes directory-entry
  // re-application a bounded echo rather than an unbounded ping-pong.
  if (options.source === "upstream") {
    const revAfter = currentRev(db);
    const existing = readWatermark(db, "pushRev", options.backend);
    if (existing >= revBeforeApply && revAfter > existing) {
      writeWatermark(db, "pushRev", revAfter, options.backend);
    }
  }

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
  const revBeforeApply = currentRev(db);
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

  if (options.source === "upstream") {
    const revAfter = currentRev(db);
    const existing = readWatermark(db, "pushRev", options.backend);
    if (existing >= revBeforeApply && revAfter > existing) {
      writeWatermark(db, "pushRev", revAfter, options.backend);
    }
  }

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
