// Public surface of @cloudflare/computer.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// computerd, and exposes a file-shaped wrapper.
//
// Backends ship under sub-path entries so the large built
// dependencies they carry (a bundled just-bash for the worker
// backend, etc.) can be tree-shaken when a consumer only uses
// one of them:
//
//   import { ContainerBackend }   from "@cloudflare/computer/backends/container";
//   import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
//
// TestBackend stays on the main entry because it's a thin
// test-only fake with no payload.
//
// Status: stable, except Workspace.push() and Workspace.pull(),
// which drive the experimental sync with computerd. The package
// README's status table is the canonical list.

export type { SyncProgress } from "@cloudflare/computer-rpc/driver";
export type {
  ApplyResult,
  DurableObjectStorageLike,
  SkippedEntry,
  SQLiteWorkspaceProviderOptions,
} from "@cloudflare/dofs";
export { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
export type { BackendHandle, WorkspaceBackend } from "./backend";
export { TestBackend, type TestBackendOptions } from "./backends/test";
export {
  getWorkspace,
  type LazyWorkspaceClient,
  type RuntimeExecOptions,
  type RuntimeGetOptions,
  type RuntimeKillOptions,
  type WorkspaceClient,
  type WorkspaceHandle,
  type WorkspaceRuntimeClient,
  type WorkspaceSource,
} from "./client";
export { decodeExecEvents, encodeExecEvents } from "./exec-wire";
export { R2Bucket, type R2BucketBinding, type R2BucketOptions } from "./mounts/providers/r2";
export {
  WorkerBundle,
  type WorkerBundleEntry,
  type WorkerBundleFile,
  type WorkerBundleOptions,
  type WorkerBundleSource,
  type WorkerBundleTree,
} from "./mounts/providers/worker-bundle";
export type {
  EagerMount,
  Mount,
  MountBase,
  MountContext,
  MountFactory,
  MountWriteAPI,
} from "./mounts/types";
export {
  createSyncLogger,
  DEFAULT_CPU_LIMIT_MS,
  type SyncBlockTelemetry,
  type SyncLogger,
  type SyncLoggerOptions,
  type SyncOperationTelemetry,
  syncBlockLog,
  syncOperationLog,
  type TelemetryRecord,
} from "./observe/sync-telemetry";
export {
  noopObserver,
  type WorkspaceAttributes,
  type WorkspaceAttributeValue,
  type WorkspaceObserver,
  type WorkspaceSpan,
} from "./observe";
export {
  ArtifactsCLITarget,
  WorkspaceProxy,
  type WorkspaceProxyProps,
  WorkspaceServiceProxy,
  type WorkspaceServiceProxyProps,
} from "./proxy";
export type { WorkspaceEgressPolicy } from "./runtime/egress";
export type { WorkspaceOutputOptions } from "./runtime/output-files";
export type { TruncatedOutput } from "./runtime/output-spool";
export type { WorkspaceBackendInfo } from "./runtime/runtime";
export type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModule,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRegisteredBackend,
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeDisposeOptions,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeInterruptPolicy,
  WorkspaceRuntimeKillOptions,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeOutputOptions,
  WorkspaceRuntimePendingCall,
  WorkspaceRuntimeResult,
  WorkspaceRuntimeStatus,
  WorkspaceRuntimeTruncation,
  WorkspaceRuntimeValue,
} from "./runtime/types";
export { unsafeToRepeat } from "./runtime/replay-safety";
export { decodeRuntimeEvents, encodeRuntimeEvent } from "./runtime/wire";
export { type RawShellValue, type ShellValue, sh, shellQuote } from "./sh";
export type { ExecEncoding, ExecSyncResult, KillSignal } from "./shell";
export {
  WorkspaceAssetsStub,
  WorkspaceFilesystemStub,
  WorkspaceGitStub,
  WorkspaceRuntimeExecHandleStub,
  WorkspaceRuntimeStub,
  WorkspaceStub,
} from "./stub";
export {
  type WithWorkspaceCtor,
  type WorkspaceLocalHost,
  type WorkspaceStubHost,
  withWorkspace,
} from "./with-workspace";
export { WorkspaceFileStore } from "./tools/common/fs/store";
export type { FileStat, FileStore, MutableFileStore } from "./tools/common/fs/types";
export { Workspace, type WorkspaceGitFactory, type WorkspaceOptions } from "./workspace";
export { WORKSPACE_ROOT } from "./workspace-root";
