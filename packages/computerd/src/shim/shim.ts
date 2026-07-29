// Userspace bidirectional sync between the @platformatic/vfs store
// and a real directory on the host filesystem. Used when FUSE is
// unavailable (no /dev/fuse, no macFUSE) and the user has opted in
// via FUSE_MOUNT=shim. Explicitly not production-grade: races between
// writers across the seam are resolved on the next reconcile tick,
// with VFS winning ties.
//
// Model:
//
//   - A "shadow" snapshot records what we last successfully synced.
//     Map<path, { kind: "file" | "dir"; size: number; mtimeMs: number }>.
//
//   - VFS -> disk runs off vfs.watchAsync("/", { recursive: true }).
//     On each event we read the VFS, write the host fs, and update
//     the shadow to match what we just wrote.
//
//   - Disk -> VFS runs off a periodic reconcile tick. We walk the
//     host directory, diff it against the shadow, and push any new
//     or changed entries into the VFS. Deletes are inferred from
//     shadow keys that no longer exist on disk.
//
// Loop suppression falls out of the shadow: after writing in either
// direction the shadow matches both sides, so the next tick on the
// opposite side sees no diff and emits nothing.

import { createHash } from "node:crypto";
import {
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { NodeVirtualFileSystem } from "../fuse/vfs.js";

export interface ShimMount {
  unmount(): Promise<void>;
  /**
   * Block until the on-disk tree at `mountPoint` reflects the
   * VFS's current state. Called by the SyncRPC `push` handler
   * after applying a peer batch so a subsequent `shell.exec` is
   * guaranteed to see the just-pushed files — the watcher-driven
   * VFS→disk path is async, and reads from spawned processes go
   * against the real fs.
   *
   * Walks the VFS tree and calls `syncVfsPathToDisk` for every
   * entry. The shadow short-circuits files that already match,
   * so flushing twice in a row is cheap.
   */
  flush(): Promise<void>;
  /**
   * Block until the VFS reflects the on-disk tree's current state.
   * Called by the SyncRPC `fetchChanges` handler right before it
   * computes the change set the puller will see, so a
   * `Workspace.pull()` issued after `shell.exec` returns observes
   * files the exec'd process wrote without waiting on the next
   * periodic poll tick.
   *
   * Runs the same disk→VFS reconcile the polling loop runs,
   * serialised through the same internal mutex so a request-time
   * call can't race with the tick. Idempotent on a clean tree.
   */
  reconcileNow(): Promise<void>;
}

export interface MountShimOptions {
  vfs: NodeVirtualFileSystem;
  mountPoint: string;
  // Disk poll cadence. Default 250ms — fast enough for an editor
  // save to surface in the VFS before the next exec command, slow
  // enough that the recursive readdir stays in the noise.
  pollIntervalMs?: number;
}

interface ShadowEntry {
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  // sha1 of the file content the last time we synced. Used to
  // detect "echo" events: when a disk→VFS write triggers the VFS
  // watcher, the watcher reads the VFS and sees content that
  // already matches the shadow. Skipping in that case prevents the
  // shim from resurrecting a file the user just deleted from disk.
  contentHash?: string;
}

type Shadow = Map<string, ShadowEntry>;

const DEFAULT_POLL_MS = 250;

export async function mountShim(options: MountShimOptions): Promise<ShimMount> {
  const { vfs, mountPoint } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  // VFS paths and host paths share the same absolute prefix:
  // `${mountPoint}/foo.txt` lives at `${mountPoint}/foo.txt` in the
  // VFS and at `${mountPoint}/foo.txt` on disk. The shim drives
  // everything off the host path; toVfs / toHost are identities,
  // kept as named helpers so the asymmetry shows up if it ever
  // creeps back in.
  await fsMkdir(mountPoint, { recursive: true });
  vfs.mkdirSync(mountPoint, { recursive: true });

  // Reconcile mutex. Both the watch loop and the poll loop mutate
  // disk + shadow; serialising them lets us keep the shadow as the
  // single source of truth for "what we last synced" without
  // racing on map updates.
  let chain: Promise<void> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const shadow: Shadow = new Map();

  // Initial materialisation: VFS is the source of truth at boot.
  // Walk it depth-first, write everything to disk, populate shadow.
  // If the mount point already has content from a previous run we
  // leave it alone — the disk-poll on the first reconcile tick
  // will treat any extra files as disk-side additions and push
  // them into the VFS. That matches the "computerd is not the only
  // writer" relaxation the shim explicitly takes on.
  await run(async () => {
    await materialiseVfsToDisk(vfs, mountPoint, shadow);
  });

  // The watcher is scoped to the mount point so any events outside
  // it (e.g. unrelated VFS writes under sibling mounts) don't drive
  // the shim. coalesceChanges emits filenames relative to the
  // watched root, so we reconstruct the absolute VFS path before
  // syncing.

  // VFS -> disk via the platformatic/dofs watcher. watchAsync
  // returns an AsyncIterable; the iterator's return() method (called
  // implicitly when we break out below, or explicitly in unmount)
  // tears down the underlying interval.
  let stopped = false;
  // watchAsync lives on the provider, not the VFS facade — the dofs
  // SQLiteWorkspaceProvider implements it via revision polling.
  const watcher = vfs.provider.watchAsync(mountPoint, { recursive: true }) as AsyncIterable<{
    eventType: "rename" | "change";
    filename: string;
  }> & { return?(): Promise<unknown> };

  const watchLoop = (async () => {
    try {
      for await (const event of watcher) {
        if (stopped) break;
        const vfsPath = joinMount(mountPoint, event.filename);
        // watchAsync emits filename="" for the watched root on some
        // operations; the mount point itself is not materialised
        // beneath itself.
        if (vfsPath === mountPoint) continue;
        await run(() => syncVfsPathToDisk(vfs, mountPoint, vfsPath, shadow));
      }
    } catch (error) {
      if (!stopped) {
        console.error("[shim] VFS watcher loop failed:", error);
      }
    }
  })();

  // Disk -> VFS via periodic reconcile. Walks the mount point,
  // diffs against the shadow, applies changes to the VFS.
  // Shared by the periodic poll below and the on-demand
  // reconcileNow() hook; both go through `run` so they serialise
  // against the VFS watcher loop.
  const reconcile = (): Promise<void> => run(() => reconcileDiskToVfs(vfs, mountPoint, shadow));
  const pollTimer = setInterval(() => {
    if (stopped) return;
    void reconcile().catch((error) => {
      console.error("[shim] disk reconcile failed:", error);
    });
  }, pollIntervalMs);
  pollTimer.unref?.();

  return {
    async unmount(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      // Best-effort: tell the AsyncIterable we're done so its
      // backing interval clears. The watcher iterator may be parked
      // inside `for await`; calling return() resolves that pending
      // next() with done:true.
      try {
        await watcher.return?.();
      } catch {
        // ignore
      }
      await watchLoop;
    },
    async flush(): Promise<void> {
      if (stopped) return;
      // Wait for anything the watcher loop has already queued, then
      // walk the VFS once and reconcile every entry against disk.
      // Both steps go through `run` so they serialise with the rest
      // of the chain — a concurrent watcher event can't sneak in a
      // write between our walk and the resolve of `flush()`.
      await run(async () => {
        await flushVfsToDisk(vfs, mountPoint, shadow);
      });
    },
    async reconcileNow(): Promise<void> {
      if (stopped) return;
      await reconcile();
    },
  };
}

// --- VFS -> disk ----------------------------------------------------------

async function materialiseVfsToDisk(
  vfs: NodeVirtualFileSystem,
  mountPoint: string,
  shadow: Shadow,
): Promise<void> {
  const queue: string[] = [mountPoint];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: string[];
    try {
      entries = vfs.readdirSync(current) as string[];
    } catch {
      continue;
    }
    for (const name of entries) {
      const vfsPath = `${current}/${name}`;
      const stat = safeVfsStat(vfs, vfsPath);
      if (stat === undefined) continue;
      const hostPath = toHostPath(mountPoint, vfsPath);
      if (stat.isDirectory()) {
        await fsMkdir(hostPath, { recursive: true });
        shadow.set(vfsPath, dirShadow(stat.mtimeMs));
        queue.push(vfsPath);
      } else if (stat.isFile()) {
        const bytes = Buffer.from(vfs.readFileSync(vfsPath) as Buffer);
        await fsWriteFile(hostPath, bytes);
        const after = await fsStat(hostPath);
        shadow.set(vfsPath, {
          kind: "file",
          size: bytes.byteLength,
          mtimeMs: after.mtimeMs,
          contentHash: hash(bytes),
        });
      }
    }
  }
}

/**
 * Walk the VFS tree and call `syncVfsPathToDisk` for every entry.
 * Unlike `materialiseVfsToDisk` (which always writes), this honors
 * the shadow so files that already match disk are no-ops. Used by
 * `ShimMount.flush()` to settle a freshly-applied push batch.
 */
async function flushVfsToDisk(
  vfs: NodeVirtualFileSystem,
  mountPoint: string,
  shadow: Shadow,
): Promise<void> {
  const queue: string[] = [mountPoint];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: string[];
    try {
      entries = vfs.readdirSync(current) as string[];
    } catch {
      continue;
    }
    for (const name of entries) {
      const vfsPath = `${current}/${name}`;
      const stat = safeVfsStat(vfs, vfsPath);
      if (stat === undefined) continue;
      await syncVfsPathToDisk(vfs, mountPoint, vfsPath, shadow);
      if (stat.isDirectory()) queue.push(vfsPath);
    }
  }
}

async function syncVfsPathToDisk(
  vfs: NodeVirtualFileSystem,
  mountPoint: string,
  vfsPath: string,
  shadow: Shadow,
): Promise<void> {
  const stat = safeVfsStat(vfs, vfsPath);
  const hostPath = toHostPath(mountPoint, vfsPath);

  if (stat === undefined) {
    // VFS says it's gone. Remove from disk + shadow. Recursive rm
    // covers the case where the VFS dropped an entire subtree in a
    // single rev (rare, but cheap to handle).
    await fsRm(hostPath, { recursive: true, force: true });
    deleteSubtreeFromShadow(shadow, vfsPath);
    return;
  }

  if (stat.isDirectory()) {
    await fsMkdir(hostPath, { recursive: true });
    shadow.set(vfsPath, dirShadow(stat.mtimeMs));
    return;
  }

  if (stat.isFile()) {
    const bytes = Buffer.from(vfs.readFileSync(vfsPath) as Buffer);
    const digest = hash(bytes);
    // Echo guard: if the shadow already records this exact content,
    // the watcher event we're servicing was triggered by our own
    // disk→VFS write a moment ago. Don't touch disk — the user
    // may have deleted or modified the file between then and now,
    // and resurrecting it would lose their change. The disk-poll
    // is responsible for propagating any such disk-side state.
    const prev = shadow.get(vfsPath);
    if (prev?.kind === "file" && prev.contentHash === digest) {
      return;
    }
    // Content-equal short-circuit: if disk already matches, skip
    // the write to avoid bumping mtime and confusing the next
    // disk-poll tick.
    const current = await readIfFile(hostPath);
    if (current === undefined || !buffersEqual(current, bytes)) {
      await fsMkdir(dirname(hostPath), { recursive: true });
      await fsWriteFile(hostPath, bytes);
    }
    const after = await fsStat(hostPath);
    shadow.set(vfsPath, {
      kind: "file",
      size: bytes.byteLength,
      mtimeMs: after.mtimeMs,
      contentHash: digest,
    });
  }
}

// --- disk -> VFS ----------------------------------------------------------

async function reconcileDiskToVfs(
  vfs: NodeVirtualFileSystem,
  mountPoint: string,
  shadow: Shadow,
): Promise<void> {
  const seen = new Set<string>();
  await walkDisk(mountPoint, mountPoint, async (hostPath, vfsPath, stat) => {
    seen.add(vfsPath);
    const prev = shadow.get(vfsPath);
    if (stat.isDirectory()) {
      if (prev?.kind === "dir") return;
      // Either new directory or replaces a file. Make sure the VFS
      // has it. mkdir with recursive matches mkdir -p semantics —
      // safe when the path already exists.
      if (prev?.kind === "file") {
        try {
          vfs.unlinkSync(vfsPath);
        } catch {
          // ignore
        }
      }
      try {
        vfs.mkdirSync(vfsPath, { recursive: true });
      } catch {
        // ignore — typically EEXIST after a concurrent create
      }
      shadow.set(vfsPath, dirShadow(stat.mtimeMs));
      return;
    }
    if (!stat.isFile()) return;
    // File. Skip if the shadow says we already have this exact
    // (size, mtime) — that's our "did anything change?" check.
    if (prev?.kind === "file" && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await fsReadFile(hostPath);
    } catch {
      return;
    }
    // Content-equal short-circuit: if the VFS already holds the same
    // bytes (e.g. an editor save that wrote identical content)
    // refresh the shadow without re-writing the VFS, which would
    // otherwise bump vfs_meta.rev and echo back over the watch loop.
    const vfsBytes = safeVfsRead(vfs, vfsPath);
    if (vfsBytes !== undefined && buffersEqual(vfsBytes, bytes)) {
      shadow.set(vfsPath, {
        kind: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contentHash: hash(bytes),
      });
      return;
    }
    try {
      // Ensure the parent dir exists in the VFS — `walkDisk` walks
      // breadth-first by default but we don't rely on parent
      // ordering being friendly.
      const parent = posix.dirname(vfsPath);
      if (parent !== "/" && parent !== ".") {
        try {
          vfs.mkdirSync(parent, { recursive: true });
        } catch {
          // ignore
        }
      }
      vfs.writeFileSync(vfsPath, bytes);
    } catch (error) {
      console.error(`[shim] failed to write ${vfsPath} into VFS:`, error);
      return;
    }
    shadow.set(vfsPath, {
      kind: "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: hash(bytes),
    });
  });

  // Deletions: anything in the shadow that the walk didn't see is
  // gone from disk. Drop it from the VFS too. Sort by depth so
  // children come before parents — vfs.rmdirSync rejects non-empty
  // directories.
  const removed = [...shadow.keys()].filter((p) => !seen.has(p));
  removed.sort((a, b) => depth(b) - depth(a));
  for (const vfsPath of removed) {
    const entry = shadow.get(vfsPath);
    if (entry === undefined) continue;
    try {
      if (entry.kind === "dir") {
        vfs.rmdirSync(vfsPath);
      } else {
        vfs.unlinkSync(vfsPath);
      }
    } catch {
      // ignore — most often a race with a concurrent VFS write
      // that already removed the entry, or a non-empty dir that
      // will get cleaned up on the next pass.
    }
    shadow.delete(vfsPath);
  }
}

async function walkDisk(
  root: string,
  current: string,
  visit: (
    hostPath: string,
    vfsPath: string,
    stat: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number },
  ) => Promise<void>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsReaddir(current);
  } catch {
    return;
  }
  for (const name of entries) {
    const hostPath = join(current, name);
    let stat: Awaited<ReturnType<typeof fsStat>>;
    try {
      stat = await fsStat(hostPath);
    } catch {
      continue;
    }
    const vfsPath = toVfsPath(root, hostPath);
    await visit(hostPath, vfsPath, stat);
    if (stat.isDirectory()) {
      await walkDisk(root, hostPath, visit);
    }
  }
}

// --- helpers --------------------------------------------------------------

// VFS and host namespaces share the same absolute paths under
// `mountPoint`. The translators are identities on the prefix; they
// strip and re-attach `mountPoint` so the rest of the code can
// stay symmetrical without sprinkling string slicing throughout.
function toHostPath(mountPoint: string, vfsPath: string): string {
  if (vfsPath === mountPoint) return mountPoint;
  const prefix = mountPoint === "/" ? "/" : `${mountPoint}/`;
  const rel = vfsPath.startsWith(prefix)
    ? vfsPath.slice(prefix.length)
    : vfsPath.replace(/^\/+/, "");
  return rel === "" ? mountPoint : join(mountPoint, rel);
}

function toVfsPath(mountPoint: string, hostPath: string): string {
  const rel = hostPath.slice(mountPoint.length).replace(/\\/g, "/");
  if (rel === "" || rel === "/") return mountPoint;
  return rel.startsWith("/") ? `${mountPoint}${rel}` : `${mountPoint}/${rel}`;
}

function joinMount(mountPoint: string, filename: string): string {
  if (filename === "" || filename === "/") return mountPoint;
  return filename.startsWith("/") ? `${mountPoint}${filename}` : `${mountPoint}/${filename}`;
}

function dirShadow(mtimeMs: number): ShadowEntry {
  return { kind: "dir", size: 0, mtimeMs };
}

function depth(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) count++;
  return count;
}

function deleteSubtreeFromShadow(shadow: Shadow, vfsPath: string): void {
  const prefix = vfsPath === "/" ? "/" : `${vfsPath}/`;
  for (const key of [...shadow.keys()]) {
    if (key === vfsPath || key.startsWith(prefix)) shadow.delete(key);
  }
}

function safeVfsStat(
  vfs: NodeVirtualFileSystem,
  path: string,
):
  | {
      isFile(): boolean;
      isDirectory(): boolean;
      size: number;
      mtimeMs: number;
    }
  | undefined {
  try {
    const s = vfs.statSync(path) as {
      isFile(): boolean;
      isDirectory(): boolean;
      size: number;
      mtime: Date;
    };
    return {
      isFile: () => s.isFile(),
      isDirectory: () => s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtime.getTime(),
    };
  } catch {
    return undefined;
  }
}

function safeVfsRead(vfs: NodeVirtualFileSystem, path: string): Buffer | undefined {
  try {
    return Buffer.from(vfs.readFileSync(path) as Buffer);
  } catch {
    return undefined;
  }
}

async function readIfFile(hostPath: string): Promise<Buffer | undefined> {
  try {
    return await fsReadFile(hostPath);
  } catch {
    return undefined;
  }
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // For small files just compare directly; for large ones hashing
  // avoids touching every byte twice (once for compare, once for
  // write). Threshold is conservative.
  if (a.byteLength < 64 * 1024) return a.equals(b);
  return hash(a) === hash(b);
}

function hash(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}
