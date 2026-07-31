import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding, ExecSyncResult, KillSignal } from "../shell.js";

export type WorkspaceRuntimeValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceRuntimeValue[]
  | { [key: string]: WorkspaceRuntimeValue };

export type WorkspaceRuntimeStatus = "completed" | "failed" | "cancelled";

type RuntimeChunk<E extends ExecEncoding> = E extends "utf8" ? string : Uint8Array;

export type WorkspaceRuntimeEvent<E extends ExecEncoding = undefined> =
  | { id: string; seq: number; name: "stdout"; value: RuntimeChunk<E> }
  | { id: string; seq: number; name: "stderr"; value: RuntimeChunk<E> }
  | { id: string; seq: number; name: "result"; value: WorkspaceRuntimeValue }
  | { id: string; seq: number; name: "exit"; value: number };

export interface WorkspaceRuntimeResult<E extends ExecEncoding = undefined> {
  status: WorkspaceRuntimeStatus;
  exitCode: number;
  stdout: E extends "utf8" ? string : Uint8Array;
  stderr: E extends "utf8" ? string : Uint8Array;
  value?: WorkspaceRuntimeValue;
  pushed: number;
  pulled: number;
  skipped: SkippedEntry[];
  sync: ExecSyncResult;
}

export interface WorkspaceRuntimeExecOptions<E extends ExecEncoding = undefined> {
  id?: string;
  backend?: string;
  cwd?: string;
  encoding?: E;
  input?: WorkspaceRuntimeValue;
  timeoutMs?: number;
}

export interface WorkspaceRuntimeGetOptions<E extends ExecEncoding = undefined> {
  backend?: string;
  encoding?: E;
  resume?: "tail" | "full" | number;
}

export interface WorkspaceRuntimeKillOptions {
  backend?: string;
  signal?: KillSignal;
}

export interface WorkspaceRuntimeDisposeOptions {
  backend?: string;
}

export interface WorkspaceRuntimeExecHandle<E extends ExecEncoding = undefined>
  extends ReadableStream<WorkspaceRuntimeEvent<E>> {
  readonly id: string;
  readonly backend: string;
  result(): Promise<WorkspaceRuntimeResult<E>>;
  kill(signal?: KillSignal): Promise<void>;
  [Symbol.dispose](): void;
}

export interface ModuleExecutionInput {
  id?: string;
  source: string;
  cwd?: string;
  input?: WorkspaceRuntimeValue;
  timeoutMs?: number;
}

export interface ModuleExecutionEnvelope {
  id: string;
  events: ReadableStream<WorkspaceRuntimeEvent>;
}

export interface WorkspaceModuleBackendHandle {
  exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope>;
  getExec(input: { id: string; after?: number | "tail" }): Promise<ModuleExecutionEnvelope>;
  killExec(input: { id: string; signal?: KillSignal }): Promise<void>;
  disposeExec(input: { id: string }): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceModuleBackendHost {
  readonly db: import("@cloudflare/dofs").Database;
  /** Attach detached backend work to the host event lifetime. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly fs: import("@cloudflare/dofs").WorkspaceFilesystem;
  readonly git: import("../git/index.js").GitClient;
  readonly artifacts: import("../artifacts/index.js").ArtifactClient;
}

export interface WorkspaceModuleBackend {
  readonly protocol: "module";
  readonly id: string;
  readonly requiresWaitUntil?: boolean;
  readonly type: string;
  connect(host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle>;
}

export type WorkspaceRegisteredBackend =
  | import("../backend.js").WorkspaceBackend
  | WorkspaceModuleBackend;

export function isModuleBackend(
  backend: WorkspaceRegisteredBackend,
): backend is WorkspaceModuleBackend {
  return "protocol" in backend && backend.protocol === "module";
}
