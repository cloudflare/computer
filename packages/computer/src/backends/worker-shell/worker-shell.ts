// WorkerShellBackend — backs Workspace with a just-bash shell that
// runs in a Dynamic Worker minted through env.LOADER.
//
// The common shape is the one ContainerBackend mirrors: the
// caller hands the backend a Loader binding plus a {binding, id}
// reference to the host DO, and the backend takes care of the
// rest. It builds the Worker Loader callback's modules table
// (core plus any opted-in command groups, plus the runtime
// stubs), wires a
// WorkspaceServiceProxy loopback into the loaded Worker's env so
// the shell can call env.HOST.getWorkspace() back into the host
// DO, mints the Dynamic Worker stub through env.LOADER.get(...),
// and reaches its named ShellWorker entrypoint with
// .getEntrypoint("ShellWorker").
//
// Because there's no second store, the BackendHandle declares
// sync: "none". Workspace.push and Workspace.pull short-circuit;
// reconcileWatermarks on connect is skipped.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import type { WorkspaceServiceProxyProps } from "../../proxy.js";
import { dynamicWorkerEgress, type WorkspaceEgressPolicy } from "../../runtime/egress.js";
import { SHELL_RUNTIME_MODULES } from "./runtime-modules.js";
import { assembleShellModules, type ShellModuleGroup } from "./shell-modules.js";

// The shape the loaded ShellWorker exposes. The host-side
// implementation lives in ./entrypoint.ts; the backend consumes
// it through the Fetcher the loader returns.
export interface WorkerShellRuntime {
  exec(input: {
    command: string;
    cwd?: string;
    id?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  }): Promise<{
    id: string;
    events: ReadableStream<Uint8Array>;
  }>;
  getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<Uint8Array>;
  }>;
  killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;
}

// Subset of cloudflare:workers' WorkerLoader the backend uses.
// Declared structurally so the file doesn't import the workerd
// types at module load.
export interface WorkerShellLoader {
  get(
    name: string,
    getCode: () => WorkerLoaderCode | Promise<WorkerLoaderCode>,
  ): {
    getEntrypoint(name?: string): unknown;
    [Symbol.dispose]?: () => void;
  };
}

interface WorkerLoaderCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | { js?: string; cjs?: string; text?: string }>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
}

// Subset of DurableObjectState the backend needs. ctx.exports is
// present at runtime but not in the public type today; declaring
// it structurally lets the backend use it without leaning on a
// cast in every call site.
interface WorkerShellContext {
  exports: {
    WorkspaceServiceProxy: (opts: { props: WorkspaceServiceProxyProps }) => unknown;
  };
}

export type WorkerShellSource =
  | {
      type: "loader";
      loader: WorkerShellLoader;
      workspace: WorkspaceServiceProxyProps;
      ctx: unknown;
    }
  | {
      type: "external-runtime";
      connect(options: {
        egress: WorkspaceEgressPolicy;
      }): WorkerShellRuntime | Promise<WorkerShellRuntime>;
    };

export interface WorkerShellBackendOptions {
  source?: WorkerShellSource;

  loader?: WorkerShellLoader;

  workspace?: WorkspaceServiceProxyProps;

  ctx?: unknown;

  loaderId?: string;

  // Compatibility date for the Dynamic Worker. Defaults to the
  // compatibility date the computer package was published with.
  compatibilityDate?: string;

  // Extra compatibility flags merged onto the default of
  // ["nodejs_compat"].
  compatibilityFlags?: string[];

  egress?: WorkspaceEgressPolicy;

  // Selector this backend is registered under in Workspace.
  // Defaults to "worker-shell"; override when the workspace hosts
  // more than one instance of the same backend kind (e.g. two
  // workers on different loaders or with different shell
  // configurations).
  id?: string;

  // Optional shell command groups to include beyond the always-on
  // core. Import the groups you want from
  // @cloudflare/computer/shell/<feature> and pass them here; the
  // backend folds them into the Loader modules table on top of
  // core. A group you never import is unreachable in your bundle
  // and the bundler drops it, so this is how you opt a command in
  // without shipping the rest.
  commands?: readonly ShellModuleGroup[];
}

const DEFAULT_COMPAT_DATE = "2026-06-17";
const DEFAULT_COMPAT_FLAGS = ["nodejs_compat"];

export class WorkerShellBackend implements WorkspaceBackend {
  readonly type = "worker-shell";
  readonly id: string;
  readonly #options: WorkerShellBackendOptions;
  readonly #egress: WorkspaceEgressPolicy;
  #egressCacheKey: string | undefined;

  constructor(options: WorkerShellBackendOptions) {
    this.id = options.id ?? "worker-shell";
    if (options.source === undefined) {
      if (
        options.loader === undefined ||
        options.workspace === undefined ||
        options.ctx === undefined
      ) {
        throw new Error(
          "WorkerShellBackend requires `source` or all of `loader`, `workspace`, and `ctx`.",
        );
      }
    } else if (
      options.loader !== undefined ||
      options.workspace !== undefined ||
      options.ctx !== undefined
    ) {
      throw new Error("WorkerShellBackend cannot combine `source` with loader options.");
    }
    this.#options = options;
    this.#egress = options.egress ?? { mode: "none" };
  }

  async connect(): Promise<BackendHandle> {
    const resolved = await this.#resolveRuntime();
    const runtime = resolved.runtime;

    const shell: ShellRPC = {
      async exec(input) {
        const envelope = await runtime.exec({
          command: input.source,
          cwd: input.cwd,
          id: input.id,
          timeoutMs: input.timeoutMs,
          env: input.env,
          stdin: input.stdin,
        });
        return { id: envelope.id, events: decodeFramedEvents(envelope.events) };
      },
      async getExec(input) {
        const envelope = await runtime.getExec(input);
        return { id: envelope.id, events: decodeFramedEvents(envelope.events) };
      },
      async killExec(input) {
        await runtime.killExec(input);
      },
      async disposeExec() {
        // The user Worker has no DB-backed log to dispose; the
        // event stream itself is the only resource and it ends
        // with the run. Treated as a no-op on this backend so
        // the ShellRPC surface stays uniform.
      },
    };

    const rpc: WorkspaceRPC = { sync: noopSync(), shell };

    return {
      rpc,
      sync: "none",
      close: async () => {
        resolved.dispose();
      },
    };
  }

  async #resolveRuntime(): Promise<{
    runtime: WorkerShellRuntime;
    dispose: () => void;
  }> {
    if (this.#options.source?.type === "external-runtime") {
      return {
        runtime: await this.#options.source.connect({ egress: this.#egress }),
        dispose: () => {},
      };
    }
    const source = this.#options.source?.type === "loader" ? this.#options.source : undefined;
    const loader = source?.loader ?? (this.#options.loader as WorkerShellLoader);
    const workspace = source?.workspace ?? (this.#options.workspace as WorkspaceServiceProxyProps);
    const ctx = (source?.ctx ?? this.#options.ctx) as WorkerShellContext;
    if (this.#egressCacheKey === undefined) {
      this.#egressCacheKey = egressCacheKey(this.#egress);
    }
    const loaderId = `${this.#options.loaderId ?? `workspace-shell:${workspace.id}`}:${this.#egressCacheKey}`;
    const compatibilityDate = this.#options.compatibilityDate ?? DEFAULT_COMPAT_DATE;
    const compatibilityFlags = this.#options.compatibilityFlags
      ? [...DEFAULT_COMPAT_FLAGS, ...this.#options.compatibilityFlags]
      : DEFAULT_COMPAT_FLAGS;

    const worker = loader.get(loaderId, () => ({
      compatibilityDate,
      compatibilityFlags,
      mainModule: "shell.js",
      modules: {
        ...assembleShellModules(this.#options.commands),
        ...SHELL_RUNTIME_MODULES,
      },
      env: {
        // Loopback Fetcher pointing at this DO's getWorkspace().
        // The shell calls env.HOST.getWorkspace() on every exec;
        // the proxy resolves env[binding].get(id).getWorkspace()
        // on the host side.
        HOST: ctx.exports.WorkspaceServiceProxy({ props: workspace }),
      },
      ...dynamicWorkerEgress(this.#egress),
    }));
    let entrypoint: unknown;
    try {
      entrypoint = worker.getEntrypoint("ShellWorker");
    } catch (error) {
      disposeQuietly(worker);
      throw error;
    }
    let disposed = false;
    return {
      runtime: entrypoint as WorkerShellRuntime,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        disposeQuietly(entrypoint as { [Symbol.dispose]?: () => void });
        disposeQuietly(worker);
      },
    };
  }
}

// Decode a byte-framed event stream produced by ShellWorker
// into the structured ExecEvent shape the runtime expects.
// Frames are newline-delimited JSON objects.
function decodeFramedEvents(source: ReadableStream<Uint8Array>): ReadableStream<ExecEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, ExecEvent>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              controller.enqueue(parseFrame(line));
            } catch (error) {
              controller.error(error);
              return;
            }
          }
          nl = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        const tail = buffer + decoder.decode();
        for (const line of tail.split("\n")) {
          if (line.length === 0) continue;
          controller.enqueue(parseFrame(line));
        }
      },
    }),
  );
}

function parseFrame(line: string): ExecEvent {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw protocolError("WorkerShellBackend received invalid execution JSON");
  }
  if (
    typeof event.id !== "string" ||
    !Number.isSafeInteger(event.seq) ||
    (event.name !== "stdout" && event.name !== "stderr" && event.name !== "exit") ||
    ((event.name === "stdout" || event.name === "stderr") && typeof event.value !== "string") ||
    (event.name === "exit" && !Number.isSafeInteger(event.value))
  ) {
    throw protocolError("WorkerShellBackend received a malformed execution frame");
  }
  return reshape(
    event as {
      id: string;
      seq: number;
      name: "stdout" | "stderr" | "exit";
      value: string | number;
    },
  );
}

function protocolError(message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = "EPROTOCOL";
  return error;
}

function reshape(event: {
  id: string;
  seq: number;
  name: "stdout" | "stderr" | "exit";
  value: string | number;
}): ExecEvent {
  // ShellWorker ships stdout / stderr values as utf8 strings;
  // ExecEvent on the wire carries Uint8Array. Re-encode so the
  // runtime's utf8 decoder transforms see the shape they already
  // handle.
  if (event.name === "stdout" || event.name === "stderr") {
    return {
      id: event.id,
      seq: event.seq,
      name: event.name,
      value: new TextEncoder().encode(event.value as string),
    };
  }
  return { id: event.id, seq: event.seq, name: "exit", code: event.value as number };
}

function egressCacheKey(policy: WorkspaceEgressPolicy): string {
  if (policy.mode !== "http-gateway") return `egress-${policy.mode}`;
  return `egress-http-gateway-${policy.revision ?? crypto.randomUUID()}`;
}

function disposeQuietly(value: { [Symbol.dispose]?: () => void }) {
  try {
    value[Symbol.dispose]?.();
  } catch {}
}

function noopSync(): SyncRPC {
  const refuse = (name: string): never => {
    throw new Error(
      `WorkerShellBackend: sync.${name} must not be called — the handle declares sync: "none"`,
    );
  };
  return {
    push: () => refuse("push") as never,
    fetchChanges: () => refuse("fetchChanges") as never,
    readEntry: () => refuse("readEntry") as never,
    hasObjects: () => refuse("hasObjects") as never,
    fetchObjects: () =>
      new ReadableStream({
        start(c) {
          c.error(new Error(`WorkerShellBackend: sync.fetchObjects must not be called`));
        },
      }),
    pushObjects: () => refuse("pushObjects") as never,
    watermarks: () => refuse("watermarks") as never,
  };
}
