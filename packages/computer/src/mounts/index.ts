// Mount indexer.
//
// Drives each registered Mount's materialize() exactly once per DO
// lifetime. Persists progress to _vfs_mounts so a subsequent
// Workspace over the same store does not re-run. Failures roll back
// the subtree under the mount root and leave _vfs_mounts.indexed = 0
// so the next pass retries from scratch.
//
// dofs's read-only mount guard reads _vfs_mounts.mode to reject
// writes under registered read-only roots. The indexer must therefore
// keep the row in 'read-write' while it materialises (otherwise its
// own mkdir / writeFile calls hit the guard) and flip to the
// registered mode only after materialize() succeeds. The cache in
// @cloudflare/dofs is invalidated after every transition so the next
// check picks up the new mode.

import type { Database, WorkspaceFilesystem } from "@cloudflare/dofs";
import { invalidateReadOnlyMountCache, ROOT_INODE } from "@cloudflare/dofs";

import type { Mount, MountWriteAPI } from "./types.js";

export interface IndexerOptions {
  db: Database;
  fs: WorkspaceFilesystem;
  // The resolved registry keyed by absolute mount root.
  mounts: Map<string, Mount>;
}

// Materialize every registered mount whose _vfs_mounts row is not
// yet marked indexed. Calls are deduped through the per-workspace
// `indexPromise` cached in MountIndex below; this free function is
// the workhorse.
async function runIndex(opts: IndexerOptions): Promise<void> {
  const { db, fs, mounts } = opts;
  // Snapshot the indexed flag per root so we don't re-run something
  // a previous attach already finished.
  const status = new Map<string, boolean>();
  for (const root of mounts.keys()) {
    const row = db.one<{ indexed: number }>("SELECT indexed FROM _vfs_mounts WHERE root = ?", root);
    status.set(root, row?.indexed === 1);
  }

  // Run every pending mount in parallel. Per-mount failures clear
  // their own subtree; the overall index call rejects with the first
  // failure once every pending mount has settled.
  const pending = [...mounts.entries()].filter(([root]) => status.get(root) !== true);
  if (pending.length === 0) return;

  const results = await Promise.allSettled(
    pending.map(async ([root, mount]) => {
      // Record the mount as registered-but-not-indexed before we
      // start writing into the subtree. mode='read-write' for the
      // duration of materialize() so the indexer's own mkdir /
      // writeFile calls bypass the dofs read-only guard; we flip
      // to mount.mode at the end. If materialize() crashes the row
      // stays with indexed=0 and the next pass retries from
      // scratch.
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, mode, indexed) VALUES (?, ?, 'read-write', 0)\n" +
          "  ON CONFLICT(root) DO UPDATE SET kind = excluded.kind, mode = 'read-write', indexed = 0",
        root,
        mount.kind,
      );
      invalidateReadOnlyMountCache(db);

      const api = createWriteAPI({ fs, root, mount });
      try {
        // Pre-create the mount root so an empty mount (one whose
        // materialize() produces zero entries) still has a
        // resolvable inode. Without this, only non-empty mounts get
        // a root — as a side effect of the first writeFile's parent
        // mkdir chain — and readdir(root) on an empty mount rejects
        // with ENOENT. The mkdir is inside the try block so a crash
        // mid-materialize rolls it back via the existing fs.rm path
        // below.
        await fs.mkdir(root, { recursive: true });
        await mount.materialize(api);
        // Stamp every node reachable from the mount root with
        // mount_root = <root>. The dofs guard reads the path → root
        // mapping from _vfs_mounts, but the provenance column also
        // exists on vfs_nodes so downstream tools (sync drop
        // reasoning, future write-back, GC of mount subtrees) can
        // tell which mount owns which inode without re-resolving
        // the path. Stamped inside the try block so the rollback
        // path wipes the stamps along with the rows.
        stampMountProvenance(db, root);
      } catch (error) {
        // Roll back anything the partial materialize landed under
        // this mount's root. We use fs.rm with recursive+force so a
        // half-created subtree leaves no orphan rows behind. The
        // row is still mode='read-write' at this point, so the rm
        // is not blocked by its own guard.
        try {
          await fs.rm(root, { recursive: true, force: true });
        } catch {
          // Best effort. If the subtree doesn't exist we still want
          // the original error to surface.
        }
        throw error;
      }
      // Flip to the registered mode and mark indexed in a single
      // UPDATE, then invalidate the guard cache so subsequent
      // writes through Workspace.fs (and any pull) see the final
      // mode.
      db.run("UPDATE _vfs_mounts SET mode = ?, indexed = 1 WHERE root = ?", mount.mode, root);
      invalidateReadOnlyMountCache(db);
    }),
  );

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    // Surface the first failure; preserve the original error so
    // tests / callers see the underlying message.
    throw failures[0].reason;
  }
}

// Walk vfs_dirents from ROOT_INODE down to the mount root's inode.
// Returns undefined when any segment is missing or hits a non-dir.
// Used by the indexer to find the root inode to stamp; we don't
// reuse resolveInode because it isn't exported from @cloudflare/dofs
// and we don't want to take a dep on its internal symlink-following
// behaviour for an indexer-only walk.
function findInodeAt(db: Database, absPath: string): number | undefined {
  if (absPath === "/") return ROOT_INODE;
  const parts = absPath.split("/").filter((p) => p.length > 0);
  let current = ROOT_INODE;
  for (const name of parts) {
    const row = db.one<{ child_inode: number; type: "file" | "dir" | "symlink" }>(
      "SELECT d.child_inode AS child_inode, n.type AS type\n" +
        "  FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode\n" +
        " WHERE d.parent_inode = ? AND d.name = ?",
      current,
      name,
    );
    if (row === undefined) return undefined;
    current = row.child_inode;
  }
  return current;
}

// Stamp vfs_nodes.mount_root = <root> on every inode reachable from
// the mount root's inode (the root itself included). The walk is
// iterative BFS over vfs_dirents so it doesn't blow the stack on
// deep trees.
function stampMountProvenance(db: Database, root: string): void {
  const rootInode = findInodeAt(db, root);
  if (rootInode === undefined) {
    // The indexer always mkdir's the root before calling this, so
    // a missing inode here means materialize() somehow tore it
    // down. Skip silently — the caller's rollback path will
    // handle the cleanup if the index pass throws.
    return;
  }
  const inodes: number[] = [rootInode];
  const queue: number[] = [rootInode];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    const children = db.all<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ?",
      parent,
    );
    for (const c of children) {
      inodes.push(c.child_inode);
      queue.push(c.child_inode);
    }
  }
  // One UPDATE per inode keeps the SQL simple and avoids building a
  // large IN-list parameter. The subtree size is bounded by the
  // materialised mount and we're inside the indexer's serialized
  // run, so this is fine for the scales we care about.
  for (const inode of inodes) {
    db.run("UPDATE vfs_nodes SET mount_root = ? WHERE inode = ?", root, inode);
  }
}

interface WriteAPIOptions {
  fs: WorkspaceFilesystem;
  root: string;
  mount: Mount;
}

function createWriteAPI(opts: WriteAPIOptions): MountWriteAPI {
  const { fs, root, mount } = opts;
  const maxBytes = mount.maxBytes;
  const maxEntries = mount.maxEntries;
  let bytesWritten = 0;
  let entriesWritten = 0;

  function checkPath(absPath: string): void {
    if (!absPath.startsWith(`${root}/`) && absPath !== root) {
      throw new Error(`mount ${root}: writeFile/mkdir target ${absPath} is outside the mount root`);
    }
  }

  return {
    root,
    async writeFile(
      absPath: string,
      source: ReadableStream<Uint8Array>,
      mode?: number,
    ): Promise<void> {
      checkPath(absPath);
      if (maxEntries !== undefined && entriesWritten + 1 > maxEntries) {
        throw new Error(`mount ${root}: maxEntries=${maxEntries} exceeded`);
      }
      entriesWritten += 1;

      // Ensure the parent directory chain exists. mkdir on an
      // existing path is EEXIST, which is fine here because the
      // recursive flag swallows that for the already-a-directory
      // case.
      const lastSlash = absPath.lastIndexOf("/");
      if (lastSlash > 0) {
        await fs.mkdir(absPath.slice(0, lastSlash), { recursive: true });
      }

      // When a byte cap is set, tee the source stream so we can
      // count bytes without buffering. The tee keeps the streaming
      // contract: bytes still flow chunk-by-chunk into writeFile.
      let toWrite: ReadableStream<Uint8Array> = source;
      if (maxBytes !== undefined) {
        const [counted, forwarded] = source.tee();
        toWrite = forwarded;
        // Drain the counted side concurrently; if the cap is
        // exceeded mid-stream, cancel the forwarded side to short
        // circuit the write.
        const cancelForwarded = (reason: unknown): void => {
          forwarded.cancel(reason).catch(() => {});
        };
        const counter = (async () => {
          const reader = counted.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value === undefined) continue;
              bytesWritten += value.byteLength;
              if (bytesWritten > maxBytes) {
                const err = new Error(
                  `mount ${root}: maxBytes=${maxBytes} exceeded (saw ${bytesWritten})`,
                );
                cancelForwarded(err);
                throw err;
              }
            }
          } finally {
            reader.releaseLock();
          }
        })();
        // Await both sides. If the counter rejects, surface that;
        // otherwise let writeFile propagate.
        const writePromise = fs.writeFile(absPath, toWrite, { mode });
        const [counterResult, writeResult] = await Promise.allSettled([counter, writePromise]);
        if (counterResult.status === "rejected") throw counterResult.reason;
        if (writeResult.status === "rejected") throw writeResult.reason;
        return;
      }
      await fs.writeFile(absPath, toWrite, { mode });
    },

    async mkdir(absPath: string, mode?: number): Promise<void> {
      checkPath(absPath);
      if (maxEntries !== undefined && entriesWritten + 1 > maxEntries) {
        throw new Error(`mount ${root}: maxEntries=${maxEntries} exceeded`);
      }
      entriesWritten += 1;
      await fs.mkdir(absPath, { recursive: true, mode });
    },
  };
}

// Singleton wrapper that the Workspace holds. The class keeps the
// in-flight promise so concurrent ensureIndexed() callers share one
// run.
export class MountIndex {
  readonly #db: Database;
  readonly #fs: WorkspaceFilesystem;
  readonly #mounts: Map<string, Mount>;
  #inFlight: Promise<void> | undefined;
  #done = false;

  constructor(opts: IndexerOptions) {
    this.#db = opts.db;
    this.#fs = opts.fs;
    this.#mounts = opts.mounts;
  }

  ensureIndexed(): Promise<void> {
    if (this.#done) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    if (this.#mounts.size === 0) {
      this.#done = true;
      return Promise.resolve();
    }
    this.#inFlight = runIndex({ db: this.#db, fs: this.#fs, mounts: this.#mounts })
      .then(() => {
        this.#done = true;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }
}
