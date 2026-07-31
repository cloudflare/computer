// getWorkspace — one front door to a Workspace, same interface
// whether you call it from the durable object that owns the Workspace
// or from a Worker across RPC.
//
//   // inside the owning durable object:
//   using ws = await getWorkspace(this);
//
//   // from a Worker:
//   using ws = await getWorkspace(env.MyDO.get(id));
//
// The durable object must extend the `withWorkspace(...)` mixin (see
// with-workspace.ts), which stashes the Workspace under a private
// symbol and exposes the `__getWorkspaceStub` prototype method.
//
// `getWorkspace` dispatches on what it's handed:
//
//   - Local host (`this`): the symbol stash holds a `Workspace`.
//     Detected with `instanceof`, so the decision doesn't depend on
//     how a remote proxy answers a symbol read. The client delegates
//     straight to the in-isolate Workspace — no serialization.
//
//   - Remote stub (`env.MyDO.get(id)`): no local Workspace, so the
//     client calls `__getWorkspaceStub()` over RPC and delegates to
//     the returned stub.
//
// Both return the same `WorkspaceClient`. The one member that needs
// adapting per path is `runtime.exec`, which accepts a tagged template
// (escaped caller-side through `sh`) as well as the plain
// `(command, options?)` form. Escaping has to run caller-side because
// a `TemplateStringsArray`'s `.raw` does not survive structured clone
// over RPC.

import type { WorkspaceFilesystem } from "@cloudflare/dofs";

import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeResult,
  WorkspaceRuntimeValue,
} from "./runtime/types.js";
import { decodeRuntimeEvents } from "./runtime/wire.js";
import { type ShellValue, sh } from "./sh.js";
import type { ExecEncoding } from "./shell.js";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace.js";
import {
  createThinkCompatibility,
  type ThinkWorkspaceCompatibility,
  Workspace,
} from "./workspace.js";

// The remote runtime handle stub: a result / stream / kill surface
// carried across Workers RPC.
interface RemoteExecHandle {
  readonly id: string | PromiseLike<string>;
  readonly backend: string | PromiseLike<string>;
  result(): Promise<WorkspaceRuntimeResult<ExecEncoding>>;
  stream(): Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
  [Symbol.dispose]?(): void;
}

// Rebuild a host-shaped ExecHandle from a remote handle stub. The
// result is a ReadableStream of decoded events with result() and
// kill() tacked on, matching what the local path returns from
// Workspace.runtime.exec.
//
// result() and iterating the stream are mutually exclusive, matching the
// local handle. Both paths wait for command post-exit synchronization before
// completing; result() also returns its synchronization counts.
async function rebuildExecHandle<E extends ExecEncoding>(
  remote: RemoteExecHandle,
  known: { id?: string; backend?: string } = {},
): Promise<WorkspaceRuntimeExecHandle<E>> {
  const [id, backend] = await Promise.all([known.id ?? remote.id, known.backend ?? remote.backend]);
  let claimed: "result" | "stream" | undefined;
  let resultPromise: Promise<WorkspaceRuntimeResult<E>> | undefined;
  let reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<E>> | undefined;
  const stream = new ReadableStream<WorkspaceRuntimeEvent<E>>(
    {
      // Lazy: don't call remote.stream() until the consumer actually
      // pulls. A result()-only caller never starts the stream, so the
      // stub's single handle is free for its run-and-wait path.
      pull: async (controller) => {
        if (claimed === "result") {
          controller.error(
            new Error(
              "exec handle already consumed by result(): result() and streaming are exclusive",
            ),
          );
          return;
        }
        if (reader === undefined) {
          claimed = "stream";
          const encoded = await remote.stream();
          reader = decodeRuntimeEvents(encoded).getReader() as ReadableStreamDefaultReader<
            WorkspaceRuntimeEvent<E>
          >;
        }
        try {
          const activeReader = reader;
          if (!activeReader) throw new Error("runtime stream reader was not initialized");
          const { value, done } = await activeReader.read();
          if (done) {
            activeReader.releaseLock();
            reader = undefined;
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          reader?.releaseLock();
          reader = undefined;
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        const activeReader = reader;
        reader = undefined;
        if (!activeReader) {
          dispose();
          return;
        }
        try {
          await activeReader.cancel(reason);
        } finally {
          activeReader.releaseLock();
          dispose();
        }
      },
    },
    // highWaterMark 0 keeps pull() from firing until a real read, so a
    // result()-only caller never trips the "already streaming" guard.
    { highWaterMark: 0 },
  );
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const activeReader = reader;
    reader = undefined;
    if (activeReader) {
      void activeReader
        .cancel()
        .catch(() => undefined)
        .finally(() => activeReader.releaseLock());
    }
    remote[Symbol.dispose]?.();
  };
  const handle = stream as WorkspaceRuntimeExecHandle<E>;
  Object.defineProperties(handle, {
    id: { value: id, enumerable: false },
    backend: { value: backend, enumerable: false },
    result: {
      value: () => {
        if (claimed === "stream") {
          throw new Error(
            "exec handle already streaming: call result() or iterate the stream, not both",
          );
        }
        claimed = "result";
        resultPromise ??= remote.result() as Promise<WorkspaceRuntimeResult<E>>;
        return resultPromise;
      },
      enumerable: false,
    },
    kill: {
      value: (signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP") => remote.kill(signal),
      enumerable: false,
    },
    [Symbol.dispose]: {
      value: dispose,
      enumerable: false,
    },
  });
  return handle;
}

// The runtime execution half of the client. `exec` takes two forms:
//
//   - Tagged template: `exec`cat ${file}``. Interpolated values are
//     escaped before the command is built. Defaults to string
//     (`utf8`) output — the ergonomic form can't carry options to ask
//     for it and a caller almost always wants text.
//
//   - Plain `(command, options?)`: forwarded unchanged. Defaults to
//     the underlying surface's default. Wrap an interpolated command
//     in `sh` to escape it: `exec(sh`cat ${file}`, { cwd })`.
//
export interface WorkspaceRuntimeClient {
  exec(
    strings: TemplateStringsArray,
    ...values: ShellValue[]
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  exec(source: string): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  exec(
    source: string,
    options: RuntimeExecOptions & { encoding: "utf8" },
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  exec(
    source: string,
    options: RuntimeExecOptions & { encoding?: undefined },
  ): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  exec(
    source: string,
    options: RuntimeExecOptions,
  ): Promise<WorkspaceRuntimeExecHandle<ExecEncoding>>;
  getExec(id: string): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  getExec(
    id: string,
    options: RuntimeGetOptions & { encoding: "utf8" },
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  getExec(
    id: string,
    options?: RuntimeGetOptions,
  ): Promise<WorkspaceRuntimeExecHandle<ExecEncoding>>;
  killExec(id: string, options?: RuntimeKillOptions): Promise<void>;
  disposeExec(id: string, options?: { backend?: string }): Promise<void>;
}

// Options accepted by the plain `exec` form, common to both paths.
export interface RuntimeExecOptions {
  cwd?: string;
  encoding?: "utf8";
  backend?: string;
  id?: string;
  timeoutMs?: number;
  input?: WorkspaceRuntimeValue;
}

export interface RuntimeGetOptions {
  encoding?: "utf8";
  backend?: string;
  resume?: "tail" | "full" | number;
}

export interface RuntimeKillOptions {
  backend?: string;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  // A tagged-template call hands the cooked strings as the first
  // argument: an array. A plain `exec(command)` call hands a string.
  return Array.isArray(value);
}

// The underlying runtime surface both paths expose: an `exec` taking a
// command string and options. Locally this is `Workspace.runtime`;
// remotely it's the runtime stub.
interface UnderlyingRuntime {
  // biome-ignore lint/suspicious/noExplicitAny: bridges local and RPC overload sets
  exec(source: string, options?: Record<string, unknown>): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: bridges local and RPC overload sets
  getExec(id: string, options?: Record<string, unknown>): Promise<any>;
  killExec(id: string, options?: RuntimeKillOptions): Promise<void>;
  disposeExec(id: string, options?: { backend?: string }): Promise<void>;
}

type RuntimeHandleMetadata = { id?: string; backend?: string };

type RehydrateRuntimeHandle = <E extends ExecEncoding>(
  handle: unknown,
  metadata?: RuntimeHandleMetadata,
) => WorkspaceRuntimeExecHandle<E> | Promise<WorkspaceRuntimeExecHandle<E>>;

function makeRuntimeClient(
  runtime: UnderlyingRuntime,
  // Adapts the handle the underlying `exec` resolves to: identity on
  // the local path (already a host handle), rebuild on the remote path.
  rehydrate: RehydrateRuntimeHandle,
): WorkspaceRuntimeClient {
  async function exec(
    commandOrStrings: string | TemplateStringsArray,
    optionsOrValue?: RuntimeExecOptions | ShellValue,
    ...rest: ShellValue[]
  ): Promise<WorkspaceRuntimeExecHandle<ExecEncoding>> {
    if (isTemplateStringsArray(commandOrStrings)) {
      const values = optionsOrValue === undefined ? rest : [optionsOrValue as ShellValue, ...rest];
      const command = sh(commandOrStrings, ...values);
      const id = crypto.randomUUID();
      return rehydrate<"utf8">(await runtime.exec(command, { id, encoding: "utf8" }), { id });
    }
    const options = withExecutionId(optionsOrValue as RuntimeExecOptions | undefined);
    const handle = await runtime.exec(
      commandOrStrings,
      options as unknown as Record<string, unknown>,
    );
    const metadata = { id: options.id, backend: options.backend };
    return options.encoding === "utf8"
      ? rehydrate<"utf8">(handle, metadata)
      : rehydrate<undefined>(handle, metadata);
  }
  const getExec = async (id: string, options?: RuntimeGetOptions) => {
    const handle = await runtime.getExec(id, options as Record<string, unknown> | undefined);
    const metadata = { id, backend: options?.backend };
    return options?.encoding === "utf8"
      ? rehydrate<"utf8">(handle, metadata)
      : rehydrate<undefined>(handle, metadata);
  };
  const killExec = (id: string, options?: RuntimeKillOptions) => runtime.killExec(id, options);
  const disposeExec = (id: string, options?: { backend?: string }) =>
    runtime.disposeExec(id, options);
  return { exec, getExec, killExec, disposeExec } as WorkspaceRuntimeClient;
}

function withExecutionId(
  options: RuntimeExecOptions | undefined,
): RuntimeExecOptions & { id: string } {
  return { ...options, id: options?.id ?? crypto.randomUUID() };
}

// The canonical client surface. `runtime.exec` is the adapted member;
// `fs`, `git`, `artifacts`, and `assets` are the underlying surface's
// members, passed through. The filesystem stub mirrors the local
// filesystem, so it also serves as the common client type.
export interface WorkspaceClient extends Partial<ThinkWorkspaceCompatibility> {
  readonly fs: WorkspaceFilesystem;
  readonly runtime: WorkspaceRuntimeClient;
  // biome-ignore lint/suspicious/noExplicitAny: git type differs local vs remote
  readonly git: any;
  // biome-ignore lint/suspicious/noExplicitAny: assets type differs local vs remote
  readonly assets: any;
  // biome-ignore lint/suspicious/noExplicitAny: artifacts type differs local vs remote
  readonly artifacts: any;
  [Symbol.dispose](): void;
}

function makeClient(
  // biome-ignore lint/suspicious/noExplicitAny: underlying surface differs per path
  surface: any,
  rehydrate: (handle: unknown, metadata?: RuntimeHandleMetadata) => unknown,
  dispose: () => void,
  useThink: boolean,
): WorkspaceClient {
  const runtime = makeRuntimeClient(
    surface.runtime as UnderlyingRuntime,
    rehydrate as RehydrateRuntimeHandle,
  );
  const client: WorkspaceClient = {
    get fs() {
      return surface.fs;
    },
    runtime,
    get git() {
      return surface.git;
    },
    get assets() {
      return surface.assets;
    },
    get artifacts() {
      return surface.artifacts;
    },
    [Symbol.dispose]: dispose,
  };
  if (useThink) Object.assign(client, createThinkCompatibility(client.fs));
  return client;
}

// What `getWorkspace` accepts: a local host carrying the symbol stash
// (the durable object `this`), or a remote stub exposing
// `__getWorkspaceStub`.
export type WorkspaceHandle = { [WORKSPACE]?: unknown } | WorkspaceStubHost;

export async function getWorkspace(handle: WorkspaceHandle): Promise<WorkspaceClient> {
  const local = (handle as { [WORKSPACE]?: unknown })[WORKSPACE];
  if (local instanceof Workspace) {
    // Local path: delegate straight to the in-isolate Workspace.
    // Nothing to dispose — the durable object owns the Workspace
    // lifecycle.
    await local.ready();
    return makeClient(
      {
        fs: local.fs,
        runtime: local.runtime,
        get git() {
          return local.git;
        },
        artifacts: local.artifacts,
        assets: local.assets,
      },
      // Local handle is already a host ExecHandle — pass it through.
      (h) => h,
      () => {},
      local.useThink,
    );
  }
  // Remote path: fetch the stub over RPC and delegate to it. Handle
  // stubs need inflating from their JSONL stream into a host-shaped
  // ExecHandle.
  const stub = await (handle as WorkspaceStubHost).__getWorkspaceStub();
  try {
    return makeClient(
      stub,
      (h, metadata) => rebuildExecHandle(h as RemoteExecHandle, metadata),
      () => {
        (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
      },
      await stub.useThink,
    );
  } catch (error) {
    (stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    throw error;
  }
}
