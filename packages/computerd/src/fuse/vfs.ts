import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

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

export interface NodeVfsHandle {
  // @platformatic/vfs filesystem the FUSE driver consumes.
  vfs: NodeVirtualFileSystem;
  // dofs Database backing the same store. Exposed so the CLI can
  // construct a createWorkspaceServer(db) and serve the local store
  // to whoever holds the capnweb session.
  db: Database;
}

// The store is local and process-lifetime. Sync is driven from the
// other end of the capnweb session: the host pushes changes in and
// pulls them back out, so nothing here polls.
export async function createNodeVirtualFileSystem(): Promise<NodeVfsHandle> {
  ensureVirtualProviderPrototype();
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());

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
  return { vfs, db };
}
