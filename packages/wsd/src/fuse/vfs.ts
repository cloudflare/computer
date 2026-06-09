import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import type { SyncRPC } from "@cloudflare/workspace-rpc";
import { pullOnce, tick } from "@cloudflare/workspace-rpc/driver";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

export type NodeVirtualFileSystem = VirtualFileSystem;

// @platformatic/vfs's create() guards on `provider instanceof
// VirtualProvider` and silently falls back to MemoryProvider when
// the check fails. dofs's SQLiteWorkspaceProvider can't import
// @platformatic/vfs (workerd target), so we splice VirtualProvider
// onto its prototype chain at the wsd boundary. The splice happens
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

export interface CreateOptions {
  // Optional upstream sync surface. When set, the local store
  // performs an initial pull on construction. When unset, wsd runs
  // standalone against an in-memory store.
  //
  // The caller owns the carrier (WebSocket, in-process direct
  // binding, or any future flavour). This package only needs the
  // typed surface; the transport seam lives in workspace-rpc.
  // Future RPCs (exec, mounts, watchers) will travel beside
  // SyncRPC on the same connection, so the caller may pass a
  // composite stub — we accept the narrow SyncRPC subset
  // structurally.
  upstream?: SyncRPC;
}

export interface NodeVfsHandle {
  // @platformatic/vfs filesystem the FUSE driver consumes.
  vfs: NodeVirtualFileSystem;
  // dofs Database backing the same store. Exposed so the
  // CLI can construct a createSyncServer(db) and serve the local
  // store to upstream callers over capnweb.
  db: Database;
  // Stop the periodic sync loop, if one was started. No-op when
  // no upstream was provided. Idempotent.
  stopSync: () => void;
}

// Polling cadence for the background sync loop. Picked to match
// human-typing latency expectations without saturating the wire.
const SYNC_TICK_MS = 250;

export async function createNodeVirtualFileSystem(
  options: CreateOptions = {},
): Promise<NodeVfsHandle> {
  ensureVirtualProviderPrototype();
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());

  let stopSync = () => {};
  if (options.upstream !== undefined) {
    // Initial pull. The polling loop would catch up eventually,
    // but the FUSE mount comes up populated by waiting for the
    // first pull to settle before returning.
    await pullOnce(db, options.upstream);
    stopSync = startSyncLoop(db, options.upstream);
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
  return { vfs, db, stopSync };
}

// Drive tick(db, upstream) on a setInterval. Errors during a tick
// log and continue — a transient upstream failure shouldn't
// kill the daemon. The watermarks are durable, so the next tick
// resumes from where the failed one would have.
function startSyncLoop(db: Database, upstream: SyncRPC): () => void {
  let stopped = false;
  const handle = setInterval(() => {
    if (stopped) return;
    tick(db, upstream).catch((error) => {
      console.error("sync tick failed:", error);
    });
  }, SYNC_TICK_MS);
  // Don't block process exit on the timer. wsd's shutdown path
  // calls stopSync() explicitly; this is belt-and-braces.
  handle.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
