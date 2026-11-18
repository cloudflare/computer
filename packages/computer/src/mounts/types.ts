// Mount type definitions.
//
// A mount populates a subtree of the workspace from an external source
// (R2, GitHub, a custom provider). Mount instances live for the
// lifetime of the `Workspace`; they're registered at construction and
// materialized lazily on first index.
//
// This module only defines the shapes. The registry that validates
// roots and resolves factories lives in registry.ts; the index pass
// that drives materialize() lives in index.ts.

import type { PassthroughDirent, PassthroughStat, SQLiteWorkspaceProvider } from "@cloudflare/dofs";

export type { PassthroughDirent, PassthroughStat };

// Common base for every concrete mount. The `kind` string is for
// diagnostics and the _vfs_mounts table; it is not interpreted.
export interface MountBase {
  readonly kind: string;
  // "read-only" rejects writes anywhere under the mount root with
  // EROFS. "read-write" lets writes pass through to the underlying
  // store; the write-back mirror to the provider lands in a later
  // milestone.
  readonly mode: "read-only" | "read-write";
  // Hard cap on total bytes the mount may land in vfs_nodes.
  // Exceeding aborts materialize() and the indexer rolls back the
  // subtree under the mount root via fs.rm. Stream-staged blob
  // rows may briefly linger and are reaped by gc(). Undefined
  // means no cap.
  readonly maxBytes?: number;
  // Hard cap on entry count (files + directories) the mount may
  // create. Same enforcement timing and rollback semantics as
  // maxBytes.
  readonly maxEntries?: number;
  // Content version. The indexer records it in _vfs_mounts.version
  // after a successful materialize() and runs materialize() again, over
  // an emptied root, when a later boot brings a different value. Leave
  // it unset to materialize once per store. A function is awaited before
  // the comparison, for sources that can only be versioned by reading
  // them asynchronously.
  readonly version?: string | (() => Promise<string>);
}

// Eager mounts populate everything in one shot through MountWriteAPI.
// This is the only strategy supported in the initial cut; the lazy
// branch is reserved for a later milestone.
//
// Indexed once per workspace store, or once per `version` when the
// mount declares one. After materialize() returns successfully — even
// if it produced zero entries — _vfs_mounts.indexed=1 is set and
// subsequent workspace boots over the same store skip this mount
// while the version is unchanged. Upstream changes (new R2 objects,
// new commits) are not picked up automatically unless the mount
// reports them through a new version; otherwise the workspace must
// be torn down and rebuilt over a fresh store.
export interface EagerMount extends MountBase {
  readonly strategy: "eager";
  materialize(api: MountWriteAPI): Promise<void>;
}

// Passthrough mounts store nothing: every read at or below the mount
// root is answered live by the mount, on every call. They are
// registered in memory each time a Workspace is constructed, with no
// _vfs_mounts row and no cache, so a Workspace opened without one has
// no files under its root. Writes under the root fail with EROFS
// without calling the mount.
//
// Paths are relative to the mount root: "" is the root itself,
// "a/b.md" a file below it. null means the path does not exist. A
// thrown WorkspaceFsError (ENOTDIR from readdir of a file, say) reaches
// the caller with its code, its message cut to 1 KiB and the path asked
// for; anything else thrown fails that one operation with EIO.
//
// Every call gets a `signal`, aborted when the operation stops needing
// the result: a find or grep that reached its limit, a file stream its
// reader cancelled. Computer sets no timeouts. See
// docs/06_mount_interface.md.
export interface PassthroughMount extends MountBase {
  readonly strategy: "passthrough";
  readonly mode: "read-only";
  stat(path: string, options?: { signal?: AbortSignal }): Promise<PassthroughStat | null>;
  // A file throws ENOTDIR. With `recursive`, every entry below `path`,
  // parents before children, names relative to `path`; find, ls and
  // grep walk a mount with one such call. The reply must hold at most
  // `limit` entries (a longer one is EIO); a mount whose tree is bigger
  // than it will list throws.
  readdir(
    path: string,
    options?: { recursive?: boolean; limit?: number; signal?: AbortSignal },
  ): Promise<PassthroughDirent[] | null>;
  // `range` comes from readFile's byteOffset and byteLength. The
  // returned `offset` is the byte of the file where `body` starts: a
  // mount that can't seek returns 0 and the whole file, and the reader
  // skips and cuts. The bytes delivered must match `stat.size`.
  readFile(
    path: string,
    options?: { range?: { offset: number; length?: number }; signal?: AbortSignal },
  ): Promise<{ stat: PassthroughStat; body: ReadableStream<Uint8Array>; offset: number } | null>;
}

// Union of every supported mount strategy.
export type Mount = EagerMount | PassthroughMount;

// Factories let callers derive a mount from per-session context
// (sessionId, root) without threading the values themselves. A bare
// Mount object is accepted everywhere a MountFactory is.
export type MountFactory = (ctx: MountContext) => Mount;

export interface MountContext {
  // Identifier for the owning workspace / session. Surfaced verbatim
  // from `WorkspaceOptions.sessionId`. Empty string when the caller
  // didn't supply one.
  sessionId: string;
  // Absolute mount root inside the VFS, no trailing slash.
  root: string;
  // Live VFS-shaped provider over the local store. Useful for mounts
  // that want to read existing state during materialize() (e.g. a
  // partial-clone hook).
  vfs: SQLiteWorkspaceProvider;
}

// Streaming write surface handed to `EagerMount.materialize()`. The
// only thing a mount can do is land files / directories in the VFS;
// it cannot read, list, or delete. writeFile accepts a
// ReadableStream so a multi-GB blob can flow through the chunked
// blob writer without ever sitting whole in memory.
//
// The `root` field carries the absolute mount root the indexer
// scoped this api to. Providers that work in terms of relative
// keys (R2, GitHub) use it to build absolute paths without
// threading a separate argument.
export interface MountWriteAPI {
  readonly root: string;
  writeFile(absPath: string, source: ReadableStream<Uint8Array>, mode?: number): Promise<void>;
  mkdir(absPath: string, mode?: number): Promise<void>;
}
