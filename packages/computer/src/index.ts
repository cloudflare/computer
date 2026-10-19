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
export type { BackendHandle, WorkspaceBackend } from "./backend.js";
export { TestBackend, type TestBackendOptions } from "./backends/test.js";
export {
  getWorkspace,
  type RuntimeExecOptions,
  type RuntimeGetOptions,
  type RuntimeKillOptions,
  type WorkspaceClient,
  type WorkspaceHandle,
  type WorkspaceRuntimeClient,
} from "./client.js";
export { decodeExecEvents, encodeExecEvents } from "./exec-wire.js";
export { R2Bucket, type R2BucketBinding, type R2BucketOptions } from "./mounts/providers/r2.js";
export {
  WorkerBundle,
  type WorkerBundleEntry,
  type WorkerBundleFile,
  type WorkerBundleOptions,
  type WorkerBundleSource,
  type WorkerBundleTree,
} from "./mounts/providers/worker-bundle.js";
export type {
  EagerMount,
  Mount,
  MountBase,
  MountContext,
  MountFactory,
  MountWriteAPI,
} from "./mounts/types.js";
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
} from "./observe/sync-telemetry.js";
export {
  noopObserver,
  type WorkspaceAttributes,
  type WorkspaceAttributeValue,
  type WorkspaceObserver,
  type WorkspaceSpan,
} from "./observe.js";
export {
  ArtifactsCLITarget,
  WorkspaceProxy,
  type WorkspaceProxyProps,
  WorkspaceServiceProxy,
  type WorkspaceServiceProxyProps,
} from "./proxy.js";
export type { WorkspaceEgressPolicy } from "./runtime/egress.js";
export type { WorkspaceOutputOptions } from "./runtime/output-files.js";
export type { TruncatedOutput } from "./runtime/output-spool.js";
export type { WorkspaceBackendInfo } from "./runtime/runtime.js";
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
} from "./runtime/types.js";
export { unsafeToRepeat } from "./runtime/replay-safety.js";
export { decodeRuntimeEvents, encodeRuntimeEvent } from "./runtime/wire.js";
export { type RawShellValue, type ShellValue, sh, shellQuote } from "./sh.js";
export type { ExecEncoding, ExecSyncResult, KillSignal } from "./shell.js";
export {
  WorkspaceAssetsStub,
  WorkspaceFilesystemStub,
  WorkspaceGitStub,
  WorkspaceRuntimeExecHandleStub,
  WorkspaceRuntimeStub,
  WorkspaceStub,
} from "./stub.js";
export {
  type WithWorkspaceCtor,
  type WorkspaceLocalHost,
  type WorkspaceStubHost,
  withWorkspace,
} from "./with-workspace.js";
export {
  type ThinkWorkspaceCompatibility,
  Workspace,
  type WorkspaceGitFactory,
  type WorkspaceOptions,
} from "./workspace.js";
