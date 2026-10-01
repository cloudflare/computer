import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding, ExecSyncResult, KillSignal } from "../shell.js";

export type WorkspaceRuntimeAccess = "read" | "read-write";

/** Per-call context the backend passes to every host module function. */
export interface WorkspaceModuleCallContext {
  /** Aborts when the call passes its deadline or the execution is cancelled. */
  readonly signal: AbortSignal;
  /** Epoch milliseconds after which the caller stops waiting for this call. */
  readonly deadline: number;
  /** Access level of the backend running the call. */
  readonly access: WorkspaceRuntimeAccess;
  /**
   * Resolve a path the isolate passed against the backend's root.
   * Rejects paths that escape the root or pass through a symlink.
   *
   * @param path - An absolute path, or one relative to the backend root.
   * @param options - Set `allowMissing` when the path may not exist yet.
   * @returns The confined absolute path.
   */
  resolvePath(path: string, options?: { readonly allowMissing?: boolean }): Promise<string>;
}

/**
 * One host function exported by a host module.
 *
 * `args` holds the arguments the isolate passed, decoded from the wire.
 * They come from untrusted code, so parse them before use. The function
 * may return a value or a promise of one. The result must be
 * JSON-compatible: the bridge checks it at runtime, treats `undefined`
 * as `null`, and drops `undefined` object fields, the way
 * `JSON.stringify` does.
 */
export type WorkspaceModuleFunction = (
  args: readonly WorkspaceRuntimeValue[],
  context: WorkspaceModuleCallContext,
) => unknown;

/** Named functions a host module exports into the isolate. */
export type WorkspaceModuleFunctions = Readonly<Record<string, WorkspaceModuleFunction>>;

/** Workspace services a host module factory can build its functions from. */
export interface WorkspaceModuleHost {
  /** The Workspace's Git client. Throws on use when Git is not configured. */
  readonly git: import("../git/index.js").GitClient;
  /** The Workspace's Artifacts client. Throws on use when Artifacts is not configured. */
  readonly artifacts: import("../artifacts/index.js").ArtifactClient;
  /** The Workspace runtime, for running commands on other backends. */
  readonly runtime: import("./runtime.js").WorkspaceRuntime;
}

/**
 * Builds a host module's functions from the Workspace's services. The
 * backend calls it once when it connects to its Workspace. The
 * prebuilt modules in `@cloudflare/computer/modules/*` are factories.
 */
export interface WorkspaceModuleFactory {
  (host: WorkspaceModuleHost): WorkspaceModuleFunctions;
  /**
   * What the module does and how to call it, for a model. The
   * JavaScript backend adds it to its own description, which the exec
   * tool shows. Objects of functions are listed by their export names.
   */
  readonly description?: string;
}

/**
 * A module caller source can import.
 *
 * - A string is JavaScript source bundled into the isolate, with no host access.
 * - An object of functions is a host module. Its functions run in the
 *   Durable Object and each becomes a named export:
 *   `{ "ws:weather": { forecast } }` lets code write
 *   `import { forecast } from "ws:weather"`.
 * - A factory is a host module that needs the Workspace's Git client,
 *   Artifacts client, or runtime, such as `createGitModule()`.
 *
 * Host modules must use a `ws:*` specifier.
 */
export type WorkspaceModule = string | WorkspaceModuleFunctions | WorkspaceModuleFactory;

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
  sync?: "wait" | "defer";
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
  sync?: "wait" | "defer";
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

/** What a module backend receives when it connects to its Workspace. */
export type WorkspaceModuleBackendHost = import("../backend.js").WorkspaceBackendHost & {
  /** The Workspace runtime, handed to host modules. */
  readonly runtime: import("./runtime.js").WorkspaceRuntime;
};

export interface WorkspaceModuleBackend {
  readonly protocol: "module";
  readonly id: string;
  readonly type: string;
  readonly callable?: boolean;
  /** What the backend tells a model about itself. Shown by the exec tool. */
  readonly description?: string;
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
