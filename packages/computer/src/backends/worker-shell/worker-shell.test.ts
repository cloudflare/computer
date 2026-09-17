// Tests for WorkerShellBackend.
//
// The backend's job is small: when Workspace.shell.exec lands, it
// dispatches into a user-supplied "shell fetcher" (the Fetcher
// returned by env.LOADER.get(...).getEntrypoint() in production,
// or any other entrypoint that satisfies the shell surface) and
// translates the byte-framed event stream the user Worker
// produces back into ReadableStream<ExecEvent>.
//
// What the backend does *not* do in this shape:
//
//   - pass a WorkspaceFilesystemStub as an exec argument. The
//     user Worker reaches the host workspace itself through a DO
//     binding the Loader callback wired into its env. That keeps
//     the I/O context where it has to be (the DO's request).
//
// Tests use a fake fetcher that mirrors the shape the runtime
// hands out, producing the same NDJSON byte frames the shell
// package's Runner would.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { Workspace } from "../../workspace.js";
import { WorkerShellBackend } from "./worker-shell.js";

type WireEvent =
  | { id: string; seq: number; name: "stdout"; value: string }
  | { id: string; seq: number; name: "stderr"; value: string }
  | { id: string; seq: number; name: "exit"; value: number };

interface FakeShellFetcher {
  exec(input: {
    command: string;
    cwd?: string;
    id?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
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

function framedStream(events: WireEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

function fakeFetcher(
  exec: (input: {
    command: string;
    cwd?: string;
    id?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }) => {
    id: string;
    events: ReadableStream<Uint8Array>;
  },
): FakeShellFetcher {
  return {
    async exec(input) {
      return exec(input);
    },
    async getExec() {
      throw new Error("getExec not used in this test");
    },
    async killExec() {
      throw new Error("killExec not used in this test");
    },
  };
}

function noopFsBackend(): WorkspaceBackend {
  // Stand-in backend so Workspace.ready() resolves without
  // wiring a real sync peer. WorkerShellBackend itself declares
  // sync: "none"; this fake just stops the test from depending
  // on a container.
  return {
    id: "noop-fs",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: {
          sync: new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as never,
          shell: new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as never,
        },
        sync: "none",
        close: async () => {},
      };
    },
  };
}

describe("WorkerShellBackend", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a BackendHandle with sync: 'none'", async () => {
    const fetcher = fakeFetcher(() => {
      throw new Error("exec not called in this test");
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [noopFsBackend()],
    });
    await ws.ready();
    const backend = new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => fetcher },
    });
    const handle = await backend.connect();
    expect(handle.sync).toBe("none");
    await handle.close();
  });

  it("dispatches exec calls through the fetcher and decodes the framed stream", async () => {
    const wireEvents: WireEvent[] = [
      { id: "run-1", seq: 1, name: "stdout", value: "hello\n" },
      { id: "run-1", seq: 2, name: "exit", value: 0 },
    ];
    let observedCommand: string | undefined;
    const fetcher = fakeFetcher((input) => {
      observedCommand = input.command;
      return { id: "run-1", events: framedStream(wireEvents) };
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [noopFsBackend()],
    });
    await ws.ready();
    const backend = new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => fetcher },
    });
    const handle = await backend.connect();

    const envelope = await handle.rpc.shell.exec({ source: "echo hello" });
    const reader = envelope.events.getReader();
    const seen: unknown[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen.push(value);
    }

    const encoder = new TextEncoder();
    expect(observedCommand).toBe("echo hello");
    expect(seen).toEqual([
      { id: "run-1", seq: 1, name: "stdout", value: encoder.encode("hello\n") },
      { id: "run-1", seq: 2, name: "exit", code: 0 },
    ]);
    expect(envelope.id).toBe("run-1");
  });

  it("forwards per-execution environment variables to the fetcher", async () => {
    let observedEnv: Record<string, string> | undefined;
    const fetcher = fakeFetcher((input) => {
      observedEnv = input.env;
      return {
        id: "env",
        events: framedStream([{ id: "env", seq: 1, name: "exit", value: 0 }]),
      };
    });
    const backend = new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => fetcher },
    });
    const handle = await backend.connect();
    const envelope = await handle.rpc.shell.exec({
      source: "printenv TOKEN",
      env: { TOKEN: "secret", EMPTY: "" },
    });
    const reader = envelope.events.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(observedEnv).toEqual({ TOKEN: "secret", EMPTY: "" });
  });

  it("errors the stream on malformed execution frames", async () => {
    const fetcher = fakeFetcher(() => ({
      id: "bad",
      events: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"bad","name":"exit"}\n'));
          controller.close();
        },
      }),
    }));
    const handle = await new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => fetcher },
    }).connect();
    const envelope = await handle.rpc.shell.exec({ source: "bad" });
    await expect(envelope.events.getReader().read()).rejects.toMatchObject({ code: "EPROTOCOL" });
  });

  it("forwards cwd and id options to the fetcher", async () => {
    let observed: { command: string; cwd?: string; id?: string } | undefined;
    const fetcher = fakeFetcher((input) => {
      observed = input;
      return {
        id: input.id ?? "auto",
        events: framedStream([{ id: input.id ?? "auto", seq: 1, name: "exit", value: 0 }]),
      };
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [noopFsBackend()],
    });
    await ws.ready();
    const backend = new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => fetcher },
    });
    const handle = await backend.connect();
    await handle.rpc.shell.exec({ source: "x", cwd: "/workspace/src", id: "fixed" });
    expect(observed?.cwd).toBe("/workspace/src");
    expect(observed?.id).toBe("fixed");
  });

  it("plumbs through Workspace.shell.exec end-to-end", async () => {
    // Construct WorkerShellBackend as the sole backend of a Workspace
    // and exercise the public shell.exec entry point. Pushes and
    // pulls are no-ops because of sync: "none".
    const fetcher = fakeFetcher((input) => ({
      id: input.id ?? "end-to-end",
      events: framedStream([
        { id: "end-to-end", seq: 1, name: "stdout", value: "world\n" },
        { id: "end-to-end", seq: 2, name: "exit", value: 0 },
      ]),
    }));
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [
        new WorkerShellBackend({ source: { type: "external-runtime", connect: () => fetcher } }),
      ],
    });
    await ws.ready();
    const handle = await ws.runtime.exec("echo world", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("world\n");
    expect(result.stderr).toBe("");
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  async function loadedId(
    commands?: readonly Readonly<Record<string, { js: string }>>[],
    overrides: { compatibilityDate?: string; compatibilityFlags?: string[] } = {},
  ): Promise<string> {
    let observed: string | undefined;
    const backend = new WorkerShellBackend({
      loader: {
        get(name: string) {
          observed = name;
          return {
            getEntrypoint: () =>
              fakeFetcher(() => ({
                id: "x",
                events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
              })),
          };
        },
      },
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
      commands,
      ...overrides,
    });
    await backend.connect();
    if (observed === undefined) throw new Error("the backend never loaded a worker");
    return observed;
  }

  async function loadedCode(
    commands?: readonly Readonly<Record<string, { js: string }>>[],
  ): Promise<{ modules: Record<string, unknown>; env: Record<string, unknown> }> {
    let code: { modules: Record<string, unknown>; env: Record<string, unknown> } | undefined;
    const backend = new WorkerShellBackend({
      loader: {
        get(
          _name: string,
          getCode: () => { modules: Record<string, unknown>; env: Record<string, unknown> },
        ) {
          code = getCode();
          return {
            getEntrypoint: () =>
              fakeFetcher(() => ({
                id: "x",
                events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
              })),
          };
        },
      },
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
      commands,
    });
    await backend.connect();
    if (code === undefined) throw new Error("the backend never loaded a worker");
    return code;
  }

  it("uses the current compatibility date for dynamic workers", async () => {
    let observedDate: string | undefined;
    let observedFlags: string[] | undefined;
    const fetcher = fakeFetcher(() => ({
      id: "x",
      events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
    }));
    const loader = {
      get(
        _name: string,
        getCode: () => { compatibilityDate?: string; compatibilityFlags?: string[] },
      ) {
        const code = getCode();
        observedDate = code.compatibilityDate;
        observedFlags = code.compatibilityFlags;
        return { getEntrypoint: () => fetcher };
      },
    };
    const ctx = {
      exports: {
        WorkspaceServiceProxy: () => ({}),
      },
    };

    const backend = new WorkerShellBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx,
    });
    await backend.connect();

    expect(observedDate).toBe("2026-06-17");
    expect(observedFlags).toEqual(["nodejs_compat"]);
  });

  // Worker Loader caches a Dynamic Worker by the identifier the backend
  // passes to loader.get. Two backends in one workspace share an
  // identifier unless their command selection is part of it, and the
  // first one to connect would then decide the module table and the
  // environment for both.
  it("gives backends with different commands different loader ids", async () => {
    const plain = await loadedId();
    const withGroup = await loadedId([{ "chunk-feature.js": { js: "export const x = 1;" } }]);

    expect(withGroup).not.toBe(plain);
  });

  it("keeps one loader id for backends with matching commands", async () => {
    const group = [{ "chunk-feature.js": { js: "export const x = 1;" } }];

    expect(await loadedId(group)).toBe(await loadedId(group));
  });

  it("uses a SHA-256 fingerprint for the Worker definition", async () => {
    expect(await loadedId()).toMatch(/:[0-9a-f]{64}$/);
  });

  it("separates groups that share a module name but not its source", async () => {
    // Chunk names carry a content hash, but a fixed name such as the
    // extras module does not, so its source has to reach the key.
    const first = await loadedId([
      { "workspace-shell-extras.js": { js: "export default () => ['browser'];" } },
    ]);
    const second = await loadedId([
      { "workspace-shell-extras.js": { js: "export default () => ['other'];" } },
    ]);

    expect(second).not.toBe(first);
  });

  it("separates groups whose module name only looks content-addressed", async () => {
    // A hand-written group can name a module in the same shape esbuild
    // uses for its content-hashed chunks. The key cannot take that
    // name as a stand-in for the source behind it.
    const first = await loadedId([{ "chunk-feature.js": { js: "export const x = 1;" } }]);
    const second = await loadedId([{ "chunk-feature.js": { js: "export const x = 2;" } }]);

    expect(second).not.toBe(first);
  });

  it("separates backends that differ only by compatibility date", async () => {
    const base = await loadedId(undefined, { compatibilityDate: "2026-06-17" });
    const later = await loadedId(undefined, { compatibilityDate: "2026-07-01" });

    expect(later).not.toBe(base);
  });

  it("separates backends that differ only by compatibility flags", async () => {
    const base = await loadedId(undefined, {});
    const extra = await loadedId(undefined, { compatibilityFlags: ["experimental"] });

    expect(extra).not.toBe(base);
  });

  it("separates an extras-carrying group from a plain one", async () => {
    const extras = await loadedId([
      { "workspace-shell-extras.js": { js: "export default () => [];" } },
    ]);

    expect(extras).not.toBe(await loadedId());
  });

  it("registers no extra commands by default", async () => {
    const code = await loadedCode();

    expect(code.modules["workspace-shell-extras.js"]).toBeUndefined();
    expect(code.env.WORKSPACE_SHELL_EXTRAS).toBeUndefined();
  });

  it("points the shell at a command group that carries extra commands", async () => {
    const group = { "workspace-shell-extras.js": { js: "export default () => [];" } };

    const code = await loadedCode([group]);

    expect(code.env.WORKSPACE_SHELL_EXTRAS).toBe("workspace-shell-extras.js");
    expect(code.modules["workspace-shell-extras.js"]).toEqual(group["workspace-shell-extras.js"]);
    // The group adds to the table; the native-dependency stubs the
    // runtime modules carry are still there.
    expect(code.modules["seek-bzip"]).toBeDefined();
  });

  it("leaves the shell alone for a group that only carries chunks", async () => {
    const code = await loadedCode([{ "chunk-abc.js": { js: "export const x = 1;" } }]);

    expect(code.env.WORKSPACE_SHELL_EXTRAS).toBeUndefined();
    expect(code.modules["chunk-abc.js"]).toBeDefined();
  });

  it("blocks ambient egress by default", async () => {
    let loaderId: string | undefined;
    let workerCode: Record<string, unknown> | undefined;
    const loader = {
      get(name: string, getCode: () => Record<string, unknown>) {
        loaderId = name;
        workerCode = getCode();
        return {
          getEntrypoint: () =>
            fakeFetcher(() => ({
              id: "x",
              events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
            })),
        };
      },
    };
    const backend = new WorkerShellBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
    });

    await backend.connect();

    // The trailing segment fingerprints the command selection; the
    // egress identity is what this case is about.
    expect(loaderId).toMatch(/^workspace-shell:abc:egress-none:[0-9a-f]{64}$/);
    expect(workerCode).toMatchObject({ globalOutbound: null });
  });

  it("omits globalOutbound for direct egress", async () => {
    let loaderId: string | undefined;
    let workerCode: Record<string, unknown> | undefined;
    const loader = {
      get(name: string, getCode: () => Record<string, unknown>) {
        loaderId = name;
        workerCode = getCode();
        return {
          getEntrypoint: () =>
            fakeFetcher(() => ({
              id: "x",
              events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
            })),
        };
      },
    };
    const backend = new WorkerShellBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
      egress: { mode: "direct" },
    });

    await backend.connect();

    expect(loaderId).toMatch(/^workspace-shell:abc:egress-direct:[0-9a-f]{64}$/);
    expect(workerCode).not.toHaveProperty("globalOutbound");
  });

  it("routes ambient egress through an HTTP gateway", async () => {
    let loaderId: string | undefined;
    let workerCode: Record<string, unknown> | undefined;
    const gateway = { fetch: async () => new Response() } as Fetcher;
    const loader = {
      get(name: string, getCode: () => Record<string, unknown>) {
        loaderId = name;
        workerCode = getCode();
        return {
          getEntrypoint: () =>
            fakeFetcher(() => ({
              id: "x",
              events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
            })),
        };
      },
    };
    const backend = new WorkerShellBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
      egress: { mode: "http-gateway", gateway, revision: "v1" },
    });

    await backend.connect();

    expect(loaderId).toMatch(/^workspace-shell:abc:egress-http-gateway-v1:[0-9a-f]{64}$/);
    expect(workerCode).toMatchObject({ globalOutbound: gateway });
  });

  it("does not generate a Loader cache key for an external runtime source", async () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-revision");
    const runtime = fakeFetcher(() => ({
      id: "x",
      events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
    }));
    const backend = new WorkerShellBackend({
      source: { type: "external-runtime", connect: () => runtime },
      egress: {
        mode: "http-gateway",
        gateway: { fetch: async () => new Response() } as Fetcher,
      },
    });

    const handle = await backend.connect();

    expect(randomUUID).not.toHaveBeenCalled();
    await handle.close();
  });

  it("generates one gateway revision when a managed Loader first connects", async () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-revision");
    const loaderIds: string[] = [];
    const runtime = fakeFetcher(() => ({
      id: "x",
      events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
    }));
    const backend = new WorkerShellBackend({
      loader: {
        get(name) {
          loaderIds.push(name);
          return { getEntrypoint: () => runtime };
        },
      },
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
      egress: {
        mode: "http-gateway",
        gateway: { fetch: async () => new Response() } as Fetcher,
      },
    });

    expect(randomUUID).not.toHaveBeenCalled();
    const first = await backend.connect();
    const second = await backend.connect();

    expect(randomUUID).toHaveBeenCalledOnce();
    expect(loaderIds).toHaveLength(2);
    expect(loaderIds[0]).toMatch(
      /^workspace-shell:abc:egress-http-gateway-generated-revision:[0-9a-f]{64}$/,
    );
    expect(loaderIds[1]).toBe(loaderIds[0]);
    await first.close();
    await second.close();
  });

  it("passes egress policy to an external runtime source", async () => {
    const runtime = fakeFetcher(() => ({
      id: "x",
      events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
    }));
    let observed: unknown;
    const backend = new WorkerShellBackend({
      source: {
        type: "external-runtime",
        async connect(options) {
          observed = options.egress;
          return runtime;
        },
      },
      egress: { mode: "direct" },
    });

    await backend.connect();

    expect(observed).toEqual({ mode: "direct" });
  });

  it("disposes Loader entrypoint and worker handles exactly once", async () => {
    let entrypointDisposals = 0;
    let workerDisposals = 0;
    const entrypoint = {
      ...fakeFetcher(() => ({
        id: "x",
        events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
      })),
      [Symbol.dispose]() {
        entrypointDisposals += 1;
      },
    };
    const loader = {
      get() {
        return {
          getEntrypoint: () => entrypoint,
          [Symbol.dispose]() {
            workerDisposals += 1;
          },
        };
      },
    };
    const backend = new WorkerShellBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
    });
    const handle = await backend.connect();
    await handle.close();
    await handle.close();
    expect(entrypointDisposals).toBe(1);
    expect(workerDisposals).toBe(1);
  });

  it("disposes the Loader worker when entrypoint creation fails", async () => {
    let workerDisposals = 0;
    const backend = new WorkerShellBackend({
      loader: {
        get() {
          return {
            getEntrypoint() {
              throw new Error("entrypoint failed");
            },
            [Symbol.dispose]() {
              workerDisposals += 1;
            },
          };
        },
      },
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx: { exports: { WorkspaceServiceProxy: () => ({}) } },
    });
    await expect(backend.connect()).rejects.toThrow("entrypoint failed");
    expect(workerDisposals).toBe(1);
  });

  it("resolves an external runtime source once per connect()", async () => {
    const fetcher = fakeFetcher(() => ({
      id: "x",
      events: framedStream([{ id: "x", seq: 1, name: "exit", value: 0 }]),
    }));
    let factoryCalls = 0;
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [noopFsBackend()],
    });
    await ws.ready();
    const backend = new WorkerShellBackend({
      source: {
        type: "external-runtime",
        async connect() {
          factoryCalls += 1;
          return fetcher;
        },
      },
    });
    const handle = await backend.connect();
    await handle.rpc.shell.exec({ source: "true" });
    await handle.rpc.shell.exec({ source: "true" });
    expect(factoryCalls).toBe(1);
  });
});
