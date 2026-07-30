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
// adapting per path is `shell.exec`, which accepts a tagged template
// (escaped caller-side through `sh`) as well as the plain
// `(command, options?)` form. Escaping has to run caller-side because
// a `TemplateStringsArray`'s `.raw` does not survive structured clone
// over RPC.

import type { WorkspaceFilesystem } from "@cloudflare/dofs";

import { decodeExecEvents } from "./exec-wire.js";
import { type ShellValue, sh } from "./sh.js";
import type { ExecEncoding, WorkspaceExecEvent } from "./shell.js";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace.js";
import {
  createThinkCompatibility,
  type ThinkWorkspaceCompatibility,
  Workspace,
} from "./workspace.js";

// The remote shell handle stub: a result / stream / kill surface
// carried across Workers RPC.
interface RemoteExecHandle {
  result(): Promise<{ exitCode: number; stdout: unknown; stderr: unknown }>;
  stream(): ReadableStream<Uint8Array>;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
  [Symbol.dispose]?(): void;
}

// Rebuild a host-shaped ExecHandle from a remote handle stub. The
// result is a ReadableStream of decoded events with id, result() and
// kill() tacked on, matching what the local path returns from
// Workspace.shell.exec.
//
// result() and iterating the stream are mutually exclusive, mirroring
// the host ExecHandle: the underlying stub drains a single handle, so
// whichever is used first wins. result() goes through the stub's
// run-and-wait path (which runs the post-exit pull); iterating goes
// through the stub's byte stream (which doesn't).
function rebuildExecHandle<E extends ExecEncoding>(remote: RemoteExecHandle, id: string): unknown {
  let started = false;
  let reader: ReadableStreamDefaultReader<WorkspaceExecEvent<E>> | undefined;
  const stream = new ReadableStream<WorkspaceExecEvent<E>>(
    {
      // Lazy: don't call remote.stream() until the consumer actually
      // pulls. A result()-only caller never starts the stream, so the
      // stub's single handle is free for its run-and-wait path.
      pull: async (controller) => {
        if (reader === undefined) {
          started = true;
          reader = decodeExecEvents<E>(remote.stream()).getReader();
        }
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => {
        void reader?.cancel(reason);
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
    void reader?.cancel();
    remote[Symbol.dispose]?.();
  };
  const handle = stream as ReadableStream<WorkspaceExecEvent<E>> & {
    readonly id: string;
    result(): Promise<unknown>;
    kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
    [Symbol.dispose](): void;
  };
  Object.defineProperties(handle, {
    id: {
      value: id,
      enumerable: false,
    },
    result: {
      value: () => {
        if (started) {
          throw new Error(
            "exec handle already streaming: call result() or iterate the stream, not both",
          );
        }
        return remote.result();
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

// The shell half of the client. `exec` takes two forms:
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
// `get` reattaches to a run by id, from any request and any handle:
//
//   using ws = await getWorkspace(env.MyDO.get(id));
//   const handle = await ws.shell.get(runId, { resume: "tail" });
//
// The id comes off a prior handle's `id` or from the caller's own
// `exec` options, so a long command outlives the request that started
// it.
//
// `R` is the handle type the underlying surface returns (the host
// `ExecHandle` locally, the handle stub remotely).
export interface WorkspaceShellClient<RUtf8, ROpts, RBytes> {
  exec(strings: TemplateStringsArray, ...values: ShellValue[]): Promise<RUtf8>;
  exec(command: string): Promise<RBytes>;
  exec(command: string, options: ShellExecOptions & { encoding: "utf8" }): Promise<RUtf8>;
  exec(command: string, options: ShellExecOptions): Promise<ROpts>;
  get(id: string): Promise<RBytes>;
  get(id: string, options: ShellGetOptions & { encoding: "utf8" }): Promise<RUtf8>;
  get(id: string, options: ShellGetOptions): Promise<ROpts>;
}

// Options accepted by the plain `exec` form, common to both paths.
export interface ShellExecOptions {
  cwd?: string;
  encoding?: "utf8";
  backend?: string;
  id?: string;
  timeoutMs?: number;
}

// Options accepted by `get`, common to both paths. `resume` picks
// where the replayed event stream starts: "tail" for live events only,
// "full" (the default) for everything buffered, or a sequence number
// to resume after.
export interface ShellGetOptions {
  encoding?: "utf8";
  resume?: "tail" | "full" | number;
  backend?: string;
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  // A tagged-template call hands the cooked strings as the first
  // argument: an array. A plain `exec(command)` call hands a string.
  return Array.isArray(value);
}

// The underlying shell surface both paths expose: an `exec` taking a
// command string and options, and a `get` taking an exec id. Locally
// this is `Workspace.shell`; remotely it's the shell stub.
interface UnderlyingShell {
  // biome-ignore lint/suspicious/noExplicitAny: bridges two concrete exec overload sets
  exec(command: string, options?: Record<string, unknown>): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: bridges two concrete get overload sets
  get(id: string, options?: Record<string, unknown>): Promise<any>;
}

function makeShellClient(
  shell: UnderlyingShell,
  // Adapts the handle the underlying `exec` resolves to: identity on
  // the local path (already a host ExecHandle carrying its own id),
  // rebuild on the remote path (a handle stub that needs inflating
  // from its JSONL stream and carries no id of its own).
  rehydrate: (handle: unknown, id: string) => unknown,
  // biome-ignore lint/suspicious/noExplicitAny: handle types differ per path
): WorkspaceShellClient<any, any, any> {
  async function exec(
    commandOrStrings: string | TemplateStringsArray,
    optionsOrValue?: ShellExecOptions | ShellValue,
    ...rest: ShellValue[]
    // biome-ignore lint/suspicious/noExplicitAny: handle types differ per path
  ): Promise<any> {
    if (isTemplateStringsArray(commandOrStrings)) {
      const values = optionsOrValue === undefined ? rest : [optionsOrValue as ShellValue, ...rest];
      const command = sh(commandOrStrings, ...values);
      const id = crypto.randomUUID();
      return rehydrate(await shell.exec(command, { id, encoding: "utf8" }), id);
    }
    const options = (optionsOrValue as ShellExecOptions | undefined) ?? {};
    // Every run is addressed by an id the caller knows, so the handle
    // exposes one on both paths and a later get() can reattach to a
    // command that outlived the request that started it. A caller
    // passing its own id keeps it; minting one here rather than
    // reading the runner's back saves a round trip on the remote
    // path, and the shell stub rejects a spawn that came back under a
    // different id.
    const id = options.id ?? crypto.randomUUID();
    return rehydrate(await shell.exec(commandOrStrings, { ...options, id }), id);
  }
  async function get(
    id: string,
    options?: ShellGetOptions,
    // biome-ignore lint/suspicious/noExplicitAny: handle types differ per path
  ): Promise<any> {
    const handle =
      options === undefined
        ? await shell.get(id)
        : await shell.get(id, options as Record<string, unknown>);
    return rehydrate(handle, id);
  }
  // biome-ignore lint/suspicious/noExplicitAny: handle types differ per path
  return { exec, get } as WorkspaceShellClient<any, any, any>;
}

// The canonical client surface. `shell.exec` is the adapted member;
// `fs`, `git`, `artifacts`, and `assets` are the underlying surface's
// members, passed through. The filesystem stub mirrors the local
// filesystem, so it also serves as the common client type.
export interface WorkspaceClient extends Partial<ThinkWorkspaceCompatibility> {
  readonly fs: WorkspaceFilesystem;
  // biome-ignore lint/suspicious/noExplicitAny: handle types differ per path
  readonly shell: WorkspaceShellClient<any, any, any>;
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
  rehydrate: (handle: unknown, id: string) => unknown,
  dispose: () => void,
  useThink: boolean,
): WorkspaceClient {
  const shell = makeShellClient(surface.shell as UnderlyingShell, rehydrate);
  const client: WorkspaceClient = {
    get fs() {
      return surface.fs;
    },
    shell,
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
        shell: local.shell,
        git: local.git,
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
      (h, id) => rebuildExecHandle(h as RemoteExecHandle, id),
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
