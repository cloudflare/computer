// Public surface of @cloudflare/workspace.
//
// The package runs inside a Cloudflare Worker / Durable
// Object. It picks a backend, holds a SyncRPC connection to
// wsd, and exposes a file-shaped facade.
//
// Backends ship under sub-path entries so the large built
// dependencies they carry (a bundled just-bash for the worker
// backend, etc.) can be tree-shaken when a consumer only uses
// one of them:
//
//   import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
//   import { WorkerBackend }              from "@cloudflare/workspace/backends/worker";
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
  WorkspaceProxy,
  type WorkspaceProxyProps,
  WorkspaceServiceProxy,
  type WorkspaceServiceProxyProps,
} from "./proxy.js";
export type {
  ExecEncoding,
  ExecHandle,
  ExecOptions,
  ExecResult,
  GetExecOptions,
  KillSignal,
  WorkspaceExecEvent,
} from "./shell.js";
export { WorkspaceShell } from "./shell.js";
export {
  WorkspaceAssetsStub,
  WorkspaceExecHandleStub,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  WorkspaceFilesystemStub,
  WorkspaceGitStub,
  WorkspaceShellStub,
  WorkspaceStub,
} from "./stub.js";
export { Workspace, type WorkspaceOptions } from "./workspace.js";
