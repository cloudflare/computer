// Public surface of @cloudflare/dofs.
//
// Status: stable, except the sync protocol building blocks, which
// serve the experimental sync with computerd.

export type { WorkspaceErrorCode, WorkspaceFsError } from "./errors";
export { createWorkspaceError } from "./errors";
export { chmod } from "./fs/chmod";
export { WorkspaceFilesystem, type WorkspaceFilesystemOptions } from "./fs/filesystem";
export type { FindOptions, WorkspaceFoundEntry } from "./fs/find";
export type { GrepOptions, WorkspaceGrepContextLine, WorkspaceGrepMatch } from "./fs/grep";
export { link } from "./fs/link";
export type { MkdirOptions } from "./fs/mkdir";
// Read-only mount enforcement. The workspace-side indexer writes
// _vfs_mounts; the helpers here let it invalidate the in-Database
// cache after a write, and let dofs callers (and tests) inspect or
// assert against the registered roots without re-implementing the
// overlap check.
export {
  assertNotReadOnly,
  getReadOnlyMountRoots,
  invalidateReadOnlyMountCache,
  readOnlyRootFor,
} from "./fs/mount-guard";
export type {
  ReaddirOptions,
  WorkspaceDirentEntry,
  WorkspaceDirentResult,
  WorkspaceDirentStats,
} from "./fs/readdir";
export type { ReadFileOptions } from "./fs/readFile";
export { readlink } from "./fs/readlink";
export { rename } from "./fs/rename";
export type { RmOptions } from "./fs/rm";
export { lstat, stat, type WorkspaceStatResult } from "./fs/stat";
export { symlink } from "./fs/symlink";
export type { WriteFileContent, WriteFileOptions } from "./fs/writeFile";
export type { SQLiteWorkspaceProviderOptions } from "./provider";
export { SQLiteWorkspaceProvider } from "./provider";
export { initializeSchema, ROOT_INODE, SCHEMA_VERSION } from "./schema/index";
export { Database } from "./storage";
export type { ApplyOptions, ApplyResult, SkippedEntry } from "./sync/apply";
// Sync protocol building blocks. The wire wiring lives in
// @cloudflare/computer-rpc; these are the helpers that wiring binds
// to a Database.
export { applyChanges, applyChangesSync } from "./sync/apply";
export { stageBlob } from "./sync/blobs";
export type {
  BlockObject,
  ModeDecision,
  PlanBlockRequest,
  PlannedBlock,
  SelectModeRequest,
} from "./sync/blocks";
export { PACK_THRESHOLD_BYTES, PACK_THRESHOLD_ENTRIES, planBlock, selectMode } from "./sync/blocks";
export type {
  DecodeChangePackOptions,
  DecodedChangePack,
  EncodeChangePackInput,
  PackFooter,
} from "./sync/change-pack";
export {
  decodeChangePack,
  encodeChangePack,
  PACK_FORMAT_VERSION,
  PackProtocolError,
  readPackFooter,
} from "./sync/change-pack";
export type { ChangeEntry } from "./sync/changes";
export { materialiseChange } from "./sync/changes";
export type { CoalesceOptions } from "./sync/coalesce";
export { coalesceChanges } from "./sync/coalesce";
export { fetchChanges, fetchObjects, hasObjects } from "./sync/fetch";
export { DEFAULT_IGNORE, isIgnored } from "./sync/ignore";
export { assertAppliedPushCursor } from "./sync/invariant";
export type { ManifestChunk } from "./sync/manifests";
export { buildManifest, MANIFEST_VERSION } from "./sync/manifests";
export type {
  BlockProfile,
  OpenedOperation,
  SyncDirection,
  SyncMode,
  SyncOperation,
  SyncOperationStatus,
  SyncSkip,
  TerminalStatus,
} from "./sync/operations";
export {
  beginCapture,
  clearBlockMarker,
  completeOperation,
  DEFAULT_BLOCK_PROFILE,
  failOperation,
  fixTarget,
  MIN_BLOCK_PROFILE,
  markBlockStarted,
  openOperation,
  pruneSkips,
  readOperation,
  readSkips,
  recordSkip,
  shrinkBlockProfile,
} from "./sync/operations";
export { pushObjects } from "./sync/push";
export type { ChangeCursor, WatermarkKey } from "./sync/watermarks";
export {
  compareChangeCursors,
  currentRev,
  pushWindowIsEmpty,
  readFetchCursor,
  readPushCursor,
  readWatermark,
  writeFetchCursor,
  writePushCursor,
  writeWatermark,
} from "./sync/watermarks";
export type { ExecutedStatement } from "./testing-recording";
// RecordingStorage is workerd-safe (pure JS). SQLiteTestStorage
// wraps node:sqlite and must be imported from
// '@cloudflare/dofs/testing' under node-only call sites.
export { RecordingStorage } from "./testing-recording";
export type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "./types";
