import { mkdir, mkdirForSyncParents } from "../fs/mkdir.js";
import { readOnlyRootFor } from "../fs/mount-guard.js";
import { resolveInode, resolveInodeWithoutSymlinks } from "../fs/resolve.js";
import { invalidateResolveSubtree } from "../fs/resolveCache.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { unlinkDirent } from "../fs/unlink.js";
import { assertChunkWindows, linkStagedChunksSync } from "../fs/writeFile.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { stageBlob } from "./blobs.js";
import type { ChangeEntry } from "./changes.js";
import { computeManifestHash } from "./manifests.js";
import { pathOf } from "./paths.js";
import {
  type ChangeCursor,
  compareChangeCursors,
  currentRev,
  DEFAULT_BACKEND_ID,
  pushWindowIsEmpty,
  readPushCursor,
} from "./watermarks.js";

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
  // Local revs this call minted. A puller compares it against how far
  // currentRev moved to tell whether every new rev came from the
  // entries it applied, which is what lets it acknowledge them to the
  // backend (see acknowledgePulledRevs in the rpc package).
  minted?: number;
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
  // upstream. 'upstream' still bumps rev so readers see fresh data,
  // and turns on the already-applied and stale-tombstone guards. The
  // rev bumps ship back to the sender on the next push unless the
  // puller acknowledges them first (acknowledgePulledRevs in rpc);
  // either way the sender's alreadyApplied() drops what it already
  // has, so an entry never circulates.
  source?: "local" | "upstream";
  // Backend id whose watermark row this apply should touch. The
  // DO hosts independent sync cursors per backend; threading the
  // id through here keeps a pull from backend A from bumping
  // backend B's pushRev. Defaults to the dofs `default` slot,
  // which is fine for the container backend the package shipped
  // with first.
  backend?: string;
  // Push receivers checkpoint the sender's cursor when committing a
  // batch. Supplying that cursor protects local recreations from an
  // already-committed delete replay; new pushes remain authoritative,
  // just like incoming writes. Pulls instead protect local versions
  // this backend has not seen, using its push cursor.
  receivedCursor?: ChangeCursor;
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

function ensureParentDirectories(
  db: Database,
  path: string,
  mtime: number,
): { path: string; blockingRoot?: string } {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length < 2) return { path: canonical };
  const parentPath = `/${parts.slice(0, -1).join("/")}`;

  const parent = resolveInodeWithoutSymlinks(db, parentPath);
  if (parent?.type === "dir") return { path: canonical };

  const reachableParent = resolveInode(db, parentPath);
  if (reachableParent?.type === "dir") {
    const resolvedParentPath = pathOf(db, reachableParent.inode);
    if (resolvedParentPath === null) {
      throw new Error(`applyChanges: resolved parent is unreachable for ${canonical}`);
    }
    const leafName = parts[parts.length - 1];
    const resolvedPath =
      resolvedParentPath === "/" ? `/${leafName}` : `${resolvedParentPath}/${leafName}`;
    return { path: resolvedPath, blockingRoot: readOnlyRootFor(db, resolvedPath) };
  }

  for (let i = 0; i < parts.length - 1; i++) {
    const ancestorPath = `/${parts.slice(0, i + 1).join("/")}`;
    const ancestor = resolveInode(db, ancestorPath, { followSymlinks: false });
    if (ancestor === null) {
      mkdirForSyncParents(db, parentPath, { recursive: true }, () => mtime);
      return { path: canonical };
    }
    if (ancestor.type === "dir") continue;
    const blockingRoot = readOnlyRootFor(db, ancestorPath);
    if (blockingRoot !== undefined) return { path: canonical, blockingRoot };
    removeInodeTreeAtPath(db, ancestorPath, ancestor.inode, ancestor.type);
    mkdirForSyncParents(db, parentPath, { recursive: true }, () => mtime);
    return { path: canonical };
  }
  return { path: canonical };
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
  let minted = 0;
  const pulled = openPullContext(db, options);
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for await (const entry of entries) {
    const revBefore = currentRev(db);
    try {
      // Idempotent skip: if the entry already matches the local
      // state, drop it on the floor. The check is what stops a
      // pull from bumping vfs_meta.rev for entries that are
      // already in place, which in turn stops the next push from
      // re-shipping them.
      if (options.source === "upstream" && entry.kind !== "delete") {
        if (alreadyApplied(db, entry)) continue;
      }
      // Protect local changes without comparing independent peer rev spaces.
      if (
        options.source === "upstream" &&
        entry.kind === "delete" &&
        tombstoneIsStale(db, entry, options, pulled)
      ) {
        continue;
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
        const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
        if (parentResult.blockingRoot !== undefined) {
          skipped.push({
            path: entry.path,
            mountRoot: parentResult.blockingRoot,
            op: "write",
            reason: "read-only",
          });
          continue;
        }
        applyDirectoryEntry(db, { ...entry, path: parentResult.path });
        applied++;
        pathsInBatch++;
        if (pathsInBatch >= maxPaths) flush();
        continue;
      }
      if (entry.kind === "symlink") {
        const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
        if (parentResult.blockingRoot !== undefined) {
          skipped.push({
            path: entry.path,
            mountRoot: parentResult.blockingRoot,
            op: "write",
            reason: "read-only",
          });
          continue;
        }
        removeReplaceableFinalEntry(db, parentResult.path, "symlink");
        symlink(db, entry.target, parentResult.path, () => entry.mtime);
        applied++;
        pathsInBatch++;
        if (pathsInBatch >= maxPaths) flush();
        continue;
      }
      const fileResult = applyFileEntry(db, entry, objects);
      if (fileResult.blockingRoot !== undefined) {
        skipped.push({
          path: entry.path,
          mountRoot: fileResult.blockingRoot,
          op: "write",
          reason: "read-only",
        });
        continue;
      }
      applied++;
      bytesInBatch += fileResult.total;
      pathsInBatch++;
      if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
    } finally {
      minted += notePulledRevs(db, pulled, revBefore);
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
  // The sound version lives in the rpc layer: a puller that started
  // with nothing to push sends an empty push carrying the new cursor,
  // and advances its own push cursor only once the receiver echoes it
  // (acknowledgePulledRevs). `minted` is what lets it check that every
  // new rev came from this apply. Otherwise the pulled revs ship on the
  // next push and the receiver's alreadyApplied() absorbs them.
  return { applied, skipped, minted };
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
  let minted = 0;
  const pulled = openPullContext(db, options);
  const flush = () => {
    bytesInBatch = 0;
    pathsInBatch = 0;
  };

  for (const entry of entries) {
    const revBefore = currentRev(db);
    try {
      if (options.source === "upstream" && entry.kind !== "delete") {
        if (alreadyApplied(db, entry)) continue;
      }
      // See tombstoneIsStale: a replayed delete must not clobber a
      // newer local recreation.
      if (
        options.source === "upstream" &&
        entry.kind === "delete" &&
        tombstoneIsStale(db, entry, options, pulled)
      ) {
        continue;
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
        const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
        if (parentResult.blockingRoot !== undefined) {
          skipped.push({
            path: entry.path,
            mountRoot: parentResult.blockingRoot,
            op: "write",
            reason: "read-only",
          });
          continue;
        }
        applyDirectoryEntry(db, { ...entry, path: parentResult.path });
        applied++;
        pathsInBatch++;
        if (pathsInBatch >= maxPaths) flush();
        continue;
      }
      if (entry.kind === "symlink") {
        const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
        if (parentResult.blockingRoot !== undefined) {
          skipped.push({
            path: entry.path,
            mountRoot: parentResult.blockingRoot,
            op: "write",
            reason: "read-only",
          });
          continue;
        }
        removeReplaceableFinalEntry(db, parentResult.path, "symlink");
        symlink(db, entry.target, parentResult.path, () => entry.mtime);
        applied++;
        pathsInBatch++;
        if (pathsInBatch >= maxPaths) flush();
        continue;
      }
      const fileResult = applyFileEntry(db, entry, objects);
      if (fileResult.blockingRoot !== undefined) {
        skipped.push({
          path: entry.path,
          mountRoot: fileResult.blockingRoot,
          op: "write",
          reason: "read-only",
        });
        continue;
      }
      applied++;
      bytesInBatch += fileResult.total;
      pathsInBatch++;
      if (bytesInBatch >= maxBytes || pathsInBatch >= maxPaths) flush();
    } finally {
      minted += notePulledRevs(db, pulled, revBefore);
    }
  }

  // See applyChanges() for why pushRev does not advance here, and
  // where pulled revs are acknowledged instead.

  return { applied, skipped, minted };
}

// Link a file entry to staged chunks without loading payload bytes.
// In-memory objects are staged individually before the link. Declared
// sizes are validated without loading payloads; chunk hashes remain
// trusted here, matching stageBlob's existing contract.
//
// Every check runs before removeReplaceableFinalEntry, so a rejected
// entry leaves whatever was already at the path alone. Batches are a
// sequence of independent transactions, so a throw part way through
// does not roll the removal back.
function applyFileEntry(
  db: Database,
  entry: Extract<ChangeEntry, { kind: "file" }>,
  objects: Map<string, Uint8Array>,
): { total: number; blockingRoot?: string } {
  assertChunkWindows(entry.chunks, entry.path);
  let total = 0;
  for (const c of entry.chunks) {
    total += c.size;
    const staged = stagedBlobSize(db, c.hash);
    if (staged === undefined) {
      const k = hex(c.hash);
      const bytes = objects.get(k);
      if (bytes === undefined) {
        throw new Error(`applyChanges: missing object ${k} for ${entry.path}`);
      }
      assertChunkSize(bytes.byteLength, c.size, c.hash, entry.path);
      stageBlob(db, c.hash, bytes, entry.mtime);
      continue;
    }
    assertChunkSize(staged, c.size, c.hash, entry.path);
  }
  const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
  if (parentResult.blockingRoot !== undefined) {
    return { total, blockingRoot: parentResult.blockingRoot };
  }
  removeReplaceableFinalEntry(db, parentResult.path, "file");
  const { parts, path: canonical } = canonicalizePath(parentResult.path);
  linkStagedChunksSync(db, canonical, parts, entry.chunks, { mode: entry.mode }, entry.mtime);
  return { total };
}

// Return a staged chunk's size without loading its payload bytes.
// A short byte row is treated as an interrupted write.
function stagedBlobSize(db: Database, hash: Uint8Array): number | undefined {
  return db.one<{ size: number }>(
    `SELECT b.size AS size
       FROM vfs_blobs b
       JOIN vfs_blob_bytes bb ON bb.hash = b.hash
      WHERE b.hash = ?
        AND length(bb.bytes) = b.size`,
    hash,
  )?.size;
}

function assertChunkSize(actual: number, declared: number, hash: Uint8Array, path: string): void {
  if (actual === declared) return;
  throw new Error(
    `applyChanges: chunk ${hex(hash)} for ${path} declares ${declared} bytes but holds ${actual}`,
  );
}

// Pulled versions this apply call minted, held in memory only.
//
// A delete is protected when it would destroy a local version the
// backend has not seen. Across calls, "seen" is the push cursor: the
// rpc layer acknowledges a clean pull, which moves the cursor over the
// versions it minted. Within one call those versions are not yet
// acknowledged, so they are tracked here. That is sound only when
// nothing local was unpushed as the call began: then every new rev the
// call mints holds what the backend sent, and a host write interleaved
// with the call mints a rev that is not in the set.
interface PullContext {
  readonly backend: string;
  readonly clean: boolean;
  readonly revs: Set<number>;
}

function openPullContext(db: Database, options: ApplyOptions): PullContext | undefined {
  if (options.source !== "upstream" || options.receivedCursor !== undefined) return undefined;
  const backend = options.backend ?? DEFAULT_BACKEND_ID;
  return { backend, clean: pushWindowIsEmpty(db, backend), revs: new Set() };
}

// Record the revs one entry minted and return how many there were.
function notePulledRevs(db: Database, pulled: PullContext | undefined, revBefore: number): number {
  const revAfter = currentRev(db);
  if (pulled?.clean === true) {
    for (let rev = revBefore + 1; rev <= revAfter; rev++) pulled.revs.add(rev);
  }
  return revAfter - revBefore;
}

// Peer entry.rev and local node.rev are independent counters, so the
// guard never compares them.
//
// On pull, a delete yields only to local versions the backend has not
// seen: a node in the doomed subtree (a directory delete removes its
// descendants too) that sits beyond the push cursor and was not minted
// by this same call from a clean start. The cursor's path matters,
// since a bounded push can ship one rev only in part. The cursor is
// the one push plans from, so the guard and push agree on what the
// backend has: a version push will not send again counts as seen.
//
// On push, the receiver's committed sender cursor identifies replays
// in the sender's own rev space. New pushes are authoritative, while a
// replay must not remove a path recreated after the original commit.
function tombstoneIsStale(
  db: Database,
  entry: ChangeEntry & { kind: "delete" },
  options: ApplyOptions,
  pulled: PullContext | undefined,
): boolean {
  const live = resolveInode(db, entry.path, { followSymlinks: false });
  if (live === null) return false;
  if (options.receivedCursor !== undefined) {
    return compareChangeCursors({ rev: entry.rev, path: entry.path }, options.receivedCursor) <= 0;
  }
  const backend = pulled?.backend ?? options.backend ?? DEFAULT_BACKEND_ID;
  const pushed = readPushCursor(db, backend);
  const candidates = db.all<{ path: string; rev: number }>(
    `WITH RECURSIVE tree(inode, path) AS (
       SELECT ?, ?
       UNION ALL
       SELECT d.child_inode,
              CASE WHEN tree.path = '/' THEN '/' || d.name ELSE tree.path || '/' || d.name END
         FROM vfs_dirents d JOIN tree ON d.parent_inode = tree.inode
     )
     SELECT tree.path AS path, n.rev AS rev
       FROM tree JOIN vfs_nodes n ON n.inode = tree.inode
      WHERE n.rev >= ?`,
    live.inode,
    entry.path,
    pushed.rev,
  );
  return candidates.some(
    (node) => compareChangeCursors(node, pushed) > 0 && pulled?.revs.has(node.rev) !== true,
  );
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
