// Public surface of @cloudflare/computer.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// computerd, and exposes a file-shaped facade.
//
// Backends ship under sub-path entries so the large built
// dependencies they carry (a bundled just-bash for the worker
// backend, etc.) can be tree-shaken when a consumer only uses
// one of them:
//
//   import { CloudflareContainerBackend } from "@cloudflare/computer/backends/container";
//   import { WorkerShellBackend }         from "@cloudflare/computer/backends/worker-shell";
//
// TestBackend stays on the main entry because it's a thin
// test-only fake with no payload.

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
export type {
  EagerMount,
  Mount,
  MountBase,
  MountContext,
  MountFactory,
  MountWriteAPI,
} from "./mounts/types.js";
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
export type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceRegisteredBackend,
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeDisposeOptions,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeResult,
  WorkspaceRuntimeStatus,
  WorkspaceRuntimeValue,
  WorkspaceTrustedModule,
} from "./runtime/types.js";
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
  type SyncRetryIntent,
  type SyncRetryOptions,
  type SyncRetryScheduler,
  type ThinkWorkspaceCompatibility,
  Workspace,
  type WorkspaceGitFactory,
  type WorkspaceOptions,
  type WorkspaceRetryPendingSyncResult,
} from "./workspace.js";
