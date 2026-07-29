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

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

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
}

// Eager mounts populate everything in one shot through MountWriteAPI.
// This is the only strategy supported in the initial cut; the lazy
// branch is reserved for a later milestone.
//
// Indexed exactly once per workspace store. After materialize()
// returns successfully — even if it produced zero entries —
// _vfs_mounts.indexed=1 is set and subsequent workspace boots over
// the same store skip this mount. Upstream changes (new R2 objects,
// new commits) are not picked up automatically; the workspace must
// be torn down and rebuilt over a fresh store.
export interface EagerMount extends MountBase {
  readonly strategy: "eager";
  materialize(api: MountWriteAPI): Promise<void>;
}

// Union of every supported mount strategy. Today only "eager"; the
// shape is open so adding "lazy" later is purely additive.
export type Mount = EagerMount;

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
