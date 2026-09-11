import {
  Database,
  initializeSchema,
  invalidateReadOnlyMountCache,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { NodeSQLiteStorage } from "@cloudflare/dofs/node";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

import type { ResolvedStore } from "./store.js";

export type NodeVirtualFileSystem = VirtualFileSystem;

// @platformatic/vfs's create() guards on `provider instanceof
// VirtualProvider` and silently falls back to MemoryProvider when
// the check fails. dofs's SQLiteWorkspaceProvider can't import
// @platformatic/vfs (workerd target), so we splice VirtualProvider
// onto its prototype chain at the computerd boundary. The splice happens
// only here, never in dofs, so the workerd build stays clean.
//
// One-time splice: SQLiteWorkspaceProvider.prototype -> VirtualProvider.prototype.
// VirtualProvider's no-op default methods stay reachable for anything
// dofs doesn't override (most of them throw ENOSYS, which is fine).
let prototypePatched = false;
function ensureVirtualProviderPrototype(): void {
  if (prototypePatched) return;
  const proto = SQLiteWorkspaceProvider.prototype as object;
  const parent = Object.getPrototypeOf(proto);
  if (parent === VirtualProvider.prototype) {
    prototypePatched = true;
    return;
  }
  // Walk to the top of the dofs chain and splice VirtualProvider in
  // just above Object.prototype. Concretely the dofs class extends
  // Object directly, so this is a single hop.
  Object.setPrototypeOf(proto, VirtualProvider.prototype);
  prototypePatched = true;
}

// Methods the dofs provider implements that @platformatic/vfs's
// VirtualFileSystem does not expose. We attach them to the vfs
// instance after create() so the FUSE driver and tests can call
// them through `vfs.x(...)` instead of reaching for the provider.
//
// Keep this list small: anything @platformatic/vfs already exposes
// (readFileSync, writeFileSync, statSync, ...) does not belong here.
const EXTRA_VFS_METHODS = [
  "linkSync",
  "createFileSync",
  "writeRangeSync",
  "truncateFileSync",
  "chmodSync",
  "readRangeSync",
  "openWriteBufferSync",
  "openWriteBufferForCreateSync",
  "releaseWriteBufferSync",
] as const;

export interface NodeVFSHandle {
  // @platformatic/vfs filesystem the FUSE driver consumes.
  vfs: NodeVirtualFileSystem;
  // dofs Database backing the same store. Exposed so the CLI can
  // construct a createWorkspaceServer(db) and serve the local store
  // to whoever holds the capnweb session.
  db: Database;
  // Which store backs this handle, as resolved by store.ts. The CLI
  // reports it on /__computerd/info.
  store: ResolvedStore;
  // Fold any write-ahead log back into the main database file.
  checkpoint: () => { walFrames: number; sizeBytes: number; durationMs: number };
  // Byte size of the store, and the pages SQLite is holding free
  // inside it. Both feed /__computerd/stats.
  storeStats: () => { sizeBytes: number; freelistCount: number };
  // Checkpoint and close the underlying database.
  close: () => void;
}

export interface CreateNodeVFSOptions {
  store?: ResolvedStore;
}

export async function createNodeVirtualFileSystem(
  options: CreateNodeVFSOptions = {},
): Promise<NodeVFSHandle> {
  ensureVirtualProviderPrototype();
  const store: ResolvedStore = options.store ?? { kind: "memory" };
  const storage = new NodeSQLiteStorage({
    location: store.kind === "file" ? store.path : ":memory:",
  });
  const db = new Database(storage);
  try {
    // On a restored store this is the migration step, and the guard
    // against a stale binary: initializeSchema migrates a database
    // written by an older computerd forward, and throws EIO on one
    // written by a newer computerd rather than corrupting it. Closing
    // the storage on the way out keeps a rejected open from leaking
    // the file handle.
    initializeSchema(db, () => Date.now());
  } catch (error) {
    storage.close();
    throw error;
  }
  // A restored store arrives with whatever _vfs_mounts rows the
  // previous process wrote. The read-only mount guard caches those
  // roots per Database, so drop the cache before anything reads
  // through it. The durable object's mount indexer re-asserts the
  // real set on connect; until it does, restored rows may be stale.
  if (store.kind === "file" && !store.fresh) {
    invalidateReadOnlyMountCache(db);
  }

  const provider = new SQLiteWorkspaceProvider(db);
  const vfs = create(provider as unknown as VirtualProvider, { moduleHooks: false });
  // Forward the extra dofs methods that @platformatic/vfs's
  // VirtualFileSystem doesn't expose. We bind directly to the
  // provider — there is no `inner` indirection — so dispatch can't
  // silently fall off if a method name only exists on one side.
  // biome-ignore lint/suspicious/noExplicitAny: untyped extension surface
  const providerAny = provider as any;
  for (const name of EXTRA_VFS_METHODS) {
    const fn = providerAny[name];
    if (typeof fn !== "function") continue;
    Object.defineProperty(vfs, name, {
      // biome-ignore lint/suspicious/noExplicitAny: untyped extension surface
      value: (...args: any[]) => fn.apply(providerAny, args),
      writable: true,
      configurable: true,
    });
  }
  return {
    vfs,
    db,
    store,
    checkpoint: () => storage.checkpoint(),
    storeStats: () => ({
      sizeBytes: storage.sizeBytes(),
      freelistCount: storage.freelistCount(),
    }),
    close: () => {
      storage.checkpoint();
      storage.close();
    },
  };
}
