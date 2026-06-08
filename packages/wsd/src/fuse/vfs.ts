import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import type { SyncRPC } from "@cloudflare/workspace-rpc";
import { pullOnce, tick } from "@cloudflare/workspace-rpc/driver";
import { create, type VirtualFileSystem, VirtualProvider } from "@platformatic/vfs";

export type NodeVirtualFileSystem = VirtualFileSystem;

// @platformatic/vfs's create() guards on `provider instanceof
// VirtualProvider` and silently falls back to MemoryProvider when
// the check fails. dofs's SQLiteWorkspaceProvider can't
// extend VirtualProvider directly without dragging the node-only
// @platformatic/vfs dependency into the workerd-targeted package,
// so we glue them together here.
//
// The subclass forwards every method to the dofs provider
// instance held in its constructor. We can't use Object.assign or
// setPrototypeOf at the seam because @platformatic/vfs's
// VirtualFileSystem reads getters (readonly, supportsSymlinks,
// supportsWatch) off the provider that the dofs class
// declares as instance properties; the wrapping pattern lets us
// pass those through cleanly without re-implementing the data
// model.

class SQLiteVirtualProvider extends VirtualProvider {
  private readonly inner: SQLiteWorkspaceProvider;

  constructor(db: Database) {
    super();
    this.inner = new SQLiteWorkspaceProvider(db);
  }

  // VirtualProvider's static getters return false by default; the
  // dofs provider declares the real values as instance
  // properties. Re-expose them on this wrapper.
  override get readonly(): boolean {
    return this.inner.readonly;
  }
  override get supportsSymlinks(): boolean {
    return this.inner.supportsSymlinks;
  }
  override get supportsWatch(): boolean {
    return this.inner.supportsWatch;
  }
}

// Wire forwarding methods on the prototype. Doing this in a loop
// outside the class body keeps the (large) method list out of the
// readable surface. Every method on the dofs provider that
// VirtualProvider declares is forwarded; the rest still throw the
// VirtualProvider default ENOSYS.
const FORWARDED_METHODS = [
  "open",
  "openSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "writeFileRangesSync",
  "appendFile",
  "appendFileSync",
  "exists",
  "existsSync",
  "copyFile",
  "copyFileSync",
  "internalModuleStat",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "symlink",
  "symlinkSync",
  "watch",
  "watchAsync",
  "watchFile",
  "unwatchFile",
  // Provider-specific fd extensions the @platformatic/vfs router
  // sometimes pokes at.
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

for (const name of FORWARDED_METHODS) {
  Object.defineProperty(SQLiteVirtualProvider.prototype, name, {
    value: function (this: SQLiteVirtualProvider, ...args: unknown[]): unknown {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch table
      const inner = (this as unknown as { inner: any }).inner;
      return inner[name](...args);
    },
    writable: true,
    configurable: true,
  });
}

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

  const provider = new SQLiteVirtualProvider(db);
  const vfs = create(provider, { moduleHooks: false });
  // @platformatic/vfs does not expose hardlink helpers on
  // VirtualFileSystem, but FUSE needs link(2). Attach the provider
  // primitive directly so the driver can call it while all ordinary
  // VFS callers keep using the standard surface.
  Object.defineProperty(vfs, "linkSync", {
    value: (existingPath: string, newPath: string) =>
      (provider as unknown as { linkSync(existingPath: string, newPath: string): void }).linkSync(
        existingPath,
        newPath,
      ),
    writable: true,
    configurable: true,
  });
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
