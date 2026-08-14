import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding, ExecSyncResult, KillSignal } from "../shell.js";

export type WorkspaceRuntimeAccess = "read" | "read-write";

export interface WorkspaceTrustedModule {
  /** Dispatch a call made through a host-installed reserved ws:* module. */
  call(
    method: string,
    args: WorkspaceRuntimeValue[],
    context?: { signal: AbortSignal; deadline: number },
  ): Promise<WorkspaceRuntimeValue>;
}

export type WorkspaceRuntimeValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceRuntimeValue[]
  | { [key: string]: WorkspaceRuntimeValue };

export interface WorkspaceRuntimeStat {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface WorkspaceRuntimeFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<WorkspaceRuntimeStat>;
  lstat(path: string): Promise<WorkspaceRuntimeStat>;
  readlink(path: string): Promise<string>;
  readdir(
    path: string,
    options?: { limit?: number },
  ): Promise<
    Array<{
      name: string;
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }>
  >;
  find(directory: string, pattern?: string): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  ls(prefix: string): Promise<string[]>;
  grep(
    pattern: string,
    path: string,
    options?: { ignoreCase?: boolean },
  ): Promise<Array<{ path: string; line: number; text: string }>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { exclusive?: boolean },
  ): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export interface WorkspaceRuntimeLoader {
  load(code: {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    limits?: { cpuMs?: number };
    mainModule: string;
    modules: Record<string, string | { js?: string }>;
    globalOutbound?: Fetcher | null;
  }): {
    getEntrypoint(name?: string, options?: { limits?: { cpuMs?: number } }): unknown;
  };
}

export type WorkspaceRuntimeStatus = "completed" | "failed" | "cancelled";

type RuntimeChunk<E extends ExecEncoding> = E extends "utf8" ? string : Uint8Array;

export type WorkspaceRuntimeEvent<E extends ExecEncoding = undefined> =
  | { id: string; seq: number; name: "stdout"; value: RuntimeChunk<E> }
  | { id: string; seq: number; name: "stderr"; value: RuntimeChunk<E> }
  | { id: string; seq: number; name: "exit"; code: number; result?: WorkspaceRuntimeValue };

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
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
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
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  timeoutMs?: number;
}

export interface ModuleExecutionEnvelope {
  id: string;
  // Identity of the process-local backend runtime that owns this
  // execution. Omitted by backends whose execution state is durable or
  // shared with the host.
  runtimeId?: string;
  events: ReadableStream<WorkspaceRuntimeEvent>;
  // Sync bracket stats for a backend that pairs with a remote store.
  // The pre-exec push count is known when the envelope is created;
  // the post-drain pull outcome settles once `events` is consumed to
  // its end. Absent for backends that reuse the host store, whose
  // result reports zeroed stats.
  sync?: {
    pushed: number;
    outcome: Promise<{ applied: number; skipped: SkippedEntry[]; sync: ExecSyncResult }>;
  };
}

export interface WorkspaceModuleBackendHandle {
  exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope>;
  getExec(input: {
    id: string;
    after?: number | "tail";
    runtimeId?: string;
  }): Promise<ModuleExecutionEnvelope>;
  killExec(input: { id: string; signal?: KillSignal; runtimeId?: string }): Promise<void>;
  disposeExec(input: { id: string; runtimeId?: string }): Promise<void>;
  // Tear down a backend-owned transport. The command adapter omits
  // it: a command backend's transport is closed through its
  // BackendHandle, not through the adapter the runtime consumes.
  close?(): Promise<void>;
}

export type WorkspaceModuleBackendHost = import("../backend.js").WorkspaceBackendHost;

export interface WorkspaceModuleBackend {
  readonly protocol: "module";
  readonly id: string;
  readonly type: string;
  readonly callable?: boolean;
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
