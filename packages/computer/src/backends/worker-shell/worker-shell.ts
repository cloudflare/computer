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
// For deployments that need a different Fetcher source — a
// Workers service binding, a Workers-for-Platforms dispatch
// namespace, a stub from custom code — pass `fetcher` instead.
// The backend stays source-agnostic; the convenience options
// just fill in the Loader callback for the common case.
//
// Because there's no second store, the BackendHandle declares
// sync: "none". Workspace.push and Workspace.pull short-circuit;
// reconcileWatermarks on connect is skipped.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import type { WorkspaceServiceProxyProps } from "../../proxy.js";
import { SHELL_RUNTIME_MODULES } from "./runtime-modules.js";
import { assembleShellModules, type ShellModuleGroup } from "./shell-modules.js";

// The shape the loaded ShellWorker exposes. The host-side
// implementation lives in ./entrypoint.ts; the backend consumes
// it through the Fetcher the loader returns.
export interface WorkerShellFetcher {
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
interface WorkerLoaderLike {
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
interface DurableObjectCtxWithExports {
  exports: {
    WorkspaceServiceProxy: (opts: { props: WorkspaceServiceProxyProps }) => unknown;
  };
}

export interface WorkerShellBackendOptions {
  // The Worker Loader binding from env. Required when `fetcher`
  // is omitted; the backend mints the Dynamic Worker through it.
  loader?: WorkerLoaderLike;

  // Reference to the host DO that owns the Workspace. The
  // backend uses {binding, id} to mint a WorkspaceServiceProxy
  // loopback the shell reaches back through. Required when
  // `fetcher` is omitted.
  workspace?: WorkspaceServiceProxyProps;

  // DurableObjectState the backend lives inside. Used to reach
  // ctx.exports.WorkspaceServiceProxy(...) when constructing the
  // loopback. Required when `fetcher` is omitted.
  ctx?: unknown;

  // The default loader id the backend hands to env.LOADER.get.
  // Defaults to `workspace-shell:${workspace.id}` so the loader
  // caches one isolate per workspace — a runaway Bash run in one
  // workspace can't OOM the shell isolate of another. Override
  // when you need a different cache key (multi-version rollouts,
  // tenanted shells, etc.).
  loaderId?: string;

  // Compatibility date for the Dynamic Worker. Defaults to the
  // compatibility date the computer package was published with.
  compatibilityDate?: string;

  // Extra compatibility flags merged onto the default of
  // ["nodejs_compat"].
  compatibilityFlags?: string[];

  // If set, takes precedence over loader / workspace / ctx and
  // is used as the Fetcher source directly. Consulted once on
  // connect(); the resolved value is held for the life of the
  // handle. Async so a caller that fetches code from KV before
  // minting the Worker Loader stub isn't forced into a
  // synchronous API.
  //
  // Use this when the Fetcher comes from somewhere other than
  // env.LOADER (a service binding, a dispatch namespace, a fake
  // in tests).
  fetcher?: () => unknown | Promise<unknown>;

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
  // without shipping the rest. Ignored on the `fetcher` path,
  // where the caller assembles the modules table itself (use
  // assembleShellModules there).
  commands?: readonly ShellModuleGroup[];
}

const DEFAULT_COMPAT_DATE = "2026-06-17";
const DEFAULT_COMPAT_FLAGS = ["nodejs_compat"];

export class WorkerShellBackend implements WorkspaceBackend {
  readonly type = "worker-shell";
  readonly id: string;
  readonly #options: WorkerShellBackendOptions;

  constructor(options: WorkerShellBackendOptions) {
    this.id = options.id ?? "worker-shell";
    if (options.fetcher === undefined) {
      if (
        options.loader === undefined ||
        options.workspace === undefined ||
        options.ctx === undefined
      ) {
        throw new Error(
          "WorkerShellBackend: pass either `fetcher` directly or all of " +
            "`loader`, `workspace`, and `ctx` so the backend can " +
            "mint the Dynamic Worker itself.",
        );
      }
    }
    this.#options = options;
  }

  async connect(): Promise<BackendHandle> {
    const resolved = await this.#resolveFetcher();
    const fetcher = resolved.fetcher as WorkerShellFetcher;

    const shell: ShellRPC = {
      async exec(input) {
        const envelope = await fetcher.exec({
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
        const envelope = await fetcher.getExec(input);
        return { id: envelope.id, events: decodeFramedEvents(envelope.events) };
      },
      async killExec(input) {
        await fetcher.killExec(input);
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

  async #resolveFetcher(): Promise<{ fetcher: unknown; dispose: () => void }> {
    if (this.#options.fetcher !== undefined) {
      return { fetcher: await this.#options.fetcher(), dispose: () => {} };
    }
    // Convenience path: the backend builds the Loader callback
    // itself. The constructor checks the required options are
    // present, so the casts here are sound.
    const loader = this.#options.loader as WorkerLoaderLike;
    const workspace = this.#options.workspace as WorkspaceServiceProxyProps;
    const ctx = this.#options.ctx as DurableObjectCtxWithExports;
    const loaderId = this.#options.loaderId ?? `workspace-shell:${workspace.id}`;
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
      // The shell has no business reaching the public internet
      // on its own. Filesystem RPCs go through env.HOST.
      globalOutbound: null,
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
      fetcher: entrypoint,
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
