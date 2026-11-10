/**
 * `@cloudflare/computer/remote-exec`: run commands in any Durable Object with a
 * `ctx.container.exec()`-shaped API, with workspace files pushed in before and pulled back after.
 * `createExecModule()` is the `codemode:exec` host module for a `CodemodeBackend`. Experimental.
 */
export { bundledRemoteExec } from "./bundle";
export { CA_BUNDLE, CA_ENV, CONTAINERS_CA, TRUST_CA_SCRIPT } from "./egress";
export {
  remoteExec,
  ExecSyncError,
  DEFAULT_AGENT_PATH,
  type RemoteExecConfig,
  type RemoteExecOptions,
  type RemoteProcess,
} from "./exec";
export { FACADE_SOURCE, FACADE_SPECIFIER } from "./facade";
export type { SyncFs } from "./fs";
export { ensureRemoteExec, type Arch, type RemoteExecBinaries } from "./install";
export { PROTOCOL } from "./messages";
export { createExecModule, type ExecModuleOptions } from "./module";
export {
  OutputCapture,
  outputSettings,
  type TruncatedOutput,
  type Truncation,
  type WorkspaceOutputOptions,
} from "./output";
export {
  ContainerExec,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_DEBOUNCE_MS,
  ExecSandbox,
  plainEgressKey,
  ProcessHandle,
  withEgress,
  type ContainerExecOptions,
  type EgressTarget,
  type PlatformContainer,
} from "./sandbox";
export { RemoteExecError } from "./session";
export type { SyncLimits, SyncReport } from "./sync";
export type {
  ExecTarget,
  ExecTargetOptions,
  ExecTargetProcess,
  ProcessStreams,
  ResolveTarget,
} from "./target";
