import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { createGitClient } from "./git/index.js";
import type { WorkspaceModuleBackend } from "./runtime/types.js";
import { WorkspaceTransportError } from "./transport-failure.js";
import { type ThinkWorkspaceCompatibility, Workspace } from "./workspace.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

function expectThinkWorkspace(
  ws: Workspace,
): asserts ws is Workspace & ThinkWorkspaceCompatibility {
  expect(ws).toHaveProperty("readFile");
  expect(ws).toHaveProperty("readFileBytes");
  expect(ws).toHaveProperty("writeFile");
  expect(ws).toHaveProperty("readDir");
  expect(ws).toHaveProperty("glob");
  expect(ws).toHaveProperty("mkdir");
  expect(ws).toHaveProperty("rm");
  expect(ws).toHaveProperty("stat");
}

// In-process fakes. We never spawn anything from the package
// code; the backend's only contract is "produce a SyncRPC
// stub that computerd would speak". A plain object is enough.
function composite(
  sync: import("@cloudflare/computer-rpc").SyncRPC,
): import("@cloudflare/computer-rpc").WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  const shell: import("@cloudflare/computer-rpc").ShellRPC = {
    exec: notWired,
    getExec: notWired,
    killExec: notWired,
    disposeExec: notWired,
  };
  return { sync, shell };
}

function fakeRpc(): import("@cloudflare/computer-rpc").SyncRPC {
  const blobs = new Map<string, Uint8Array>();
  const files = new Map<
    string,
    { mode: number; mtime: number; size: number; chunks: { hash: Uint8Array; size: number }[] }
  >();

  function hex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  return {
    async push(input) {
      const reader = input.changes.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.kind === "file") {
            files.set(value.path, {
              mode: value.mode,
              mtime: value.mtime,
              size: value.size,
              chunks: value.chunks,
            });
          } else if (value.kind === "delete") {
            files.delete(value.path);
          }
        }
      } finally {
        reader.releaseLock();
      }
      return { rev: 0, appliedPushCursor: { rev: input.senderRev, path: null } };
    },
    async fetchChanges() {
      return {
        currentCursor: { rev: 0, path: null },
        appliedPushCursor: { rev: 0, path: null },
        stream: new ReadableStream<import("@cloudflare/dofs").ChangeEntry>({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async readEntry(path) {
      const entry = files.get(path);
      if (entry === undefined) return null;
      return {
        kind: "file",
        rev: 0,
        path,
        mode: entry.mode,
        mtime: entry.mtime,
        size: entry.size,
        chunks: entry.chunks,
      };
    },
    async hasObjects(hashes) {
      return hashes.filter((h) => blobs.has(hex(h)));
    },
    fetchObjects(hashes) {
      return new ReadableStream({
        start(c) {
          for (const h of hashes) {
            const bytes = blobs.get(hex(h));
            if (bytes !== undefined) c.enqueue({ hash: h, bytes });
          }
          c.close();
        },
      });
    },
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
    },
    async pushObjects(objects) {
      const reader = objects.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          blobs.set(hex(value.hash), value.bytes);
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function makeBackend(
  id: string,
  rpc?: import("@cloudflare/computer-rpc").SyncRPC,
): WorkspaceBackend {
  return {
    id,
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return { rpc: composite(rpc ?? fakeRpc()), close: async () => {} };
    },
  };
}

// Backend with a wired shell.exec that pings a counter on every
// call. exec resolves immediately with an empty event stream so
// the command executor's exec bracket settles right away. Used by
// the multi-backend selection tests.
function execBackend(id: string, onExec: (command: string) => void): WorkspaceBackend {
  const shell: import("@cloudflare/computer-rpc").ShellRPC = {
    async exec(input) {
      onExec(input.source);
      const execId = input.id ?? `${id}-${Math.random().toString(36).slice(2)}`;
      return {
        id: execId,
        events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
          start(c) {
            c.enqueue({ id: execId, seq: 1, name: "exit", code: 0 });
            c.close();
          },
        }),
      };
    },
    getExec: () => Promise.reject(new Error("not used")),
    killExec: () => Promise.reject(new Error("not used")),
    disposeExec: () => Promise.reject(new Error("not used")),
  };
  return {
    id,
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: { sync: fakeRpc(), shell },
        sync: "none",
        close: async () => {},
      };
    },
  };
}

// Drain an ExecHandle (or its result()-aware wrapper) to settle
// the command executor's push/pull bracket. The selection tests
// don't care about the values — only that exec ran on the right
// backend.
async function drainExec(handle: { result(): Promise<unknown> }): Promise<void> {
  await handle.result();
}

describe("Workspace backend selection", () => {
  it("picks the first backend in the list as the default", async () => {
    // Two backends; only the first has its shell.exec wired. With
    // no explicit id on the call, exec should land on the first.
    let aExecs = 0;
    let bExecs = 0;
    const a = execBackend("a", () => {
      aExecs += 1;
    });
    const b = execBackend("b", () => {
      bExecs += 1;
    });
    const ws = new Workspace({ storage: makeStorage(), backends: [a, b] });
    await ws.ready();
    const handle = await ws.runtime.exec("true");
    await drainExec(handle);
    expect(aExecs).toBe(1);
    expect(bExecs).toBe(0);
  });

  it("routes exec to the backend named in ExecOptions.backend", async () => {
    let aExecs = 0;
    let bExecs = 0;
    const a = execBackend("a", () => {
      aExecs += 1;
    });
    const b = execBackend("b", () => {
      bExecs += 1;
    });
    const ws = new Workspace({ storage: makeStorage(), backends: [a, b] });
    await ws.ready();
    await drainExec(await ws.runtime.exec("true", { backend: "b" }));
    expect(aExecs).toBe(0);
    expect(bExecs).toBe(1);
  });

  it("routes command backends through workspace.runtime.exec", async () => {
    let calls = 0;
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        execBackend("container-shell", () => {
          calls += 1;
        }),
      ],
    });
    const handle = await ws.runtime.exec("true", {
      backend: "container-shell",
      encoding: "utf8",
    });
    const result = await handle.result();
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("rejects structured input for a non-callable command backend", async () => {
    const backend = execBackend("command", () => {});
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await expect(ws.runtime.exec("true", { backend: "command", input: { a: 1 } })).rejects.toThrow(
      /not callable/,
    );
  });

  it("forwards per-execution stdin to command backends", async () => {
    let receivedStdin: Uint8Array | undefined;
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec(input) {
        receivedStdin = input.stdin;
        const id = input.id ?? "stdin-command";
        return {
          id,
          events: new ReadableStream({
            start(controller) {
              controller.enqueue({ id, seq: 1, name: "exit", code: 0 });
              controller.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: async () => undefined,
    };
    const backend: WorkspaceBackend = {
      id: "command",
      type: "fake",
      async connect() {
        return { rpc: { sync: fakeRpc(), shell }, sync: "none", close: async () => undefined };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await drainExec(await ws.runtime.exec("cat", { backend: "command", stdin: "piped" }));
    expect(receivedStdin).toEqual(new TextEncoder().encode("piped"));
  });

  it("forwards per-execution environment variables to command backends", async () => {
    let receivedEnv: Record<string, string> | undefined;
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec(input) {
        receivedEnv = input.env;
        const id = input.id ?? "env-command";
        return {
          id,
          events: new ReadableStream({
            start(controller) {
              controller.enqueue({ id, seq: 1, name: "exit", code: 0 });
              controller.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: async () => undefined,
    };
    const backend: WorkspaceBackend = {
      id: "command",
      type: "fake",
      async connect() {
        return { rpc: { sync: fakeRpc(), shell }, sync: "none", close: async () => undefined };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await drainExec(
      await ws.runtime.exec("printenv TOKEN", {
        backend: "command",
        env: { TOKEN: "secret", EMPTY: "" },
      }),
    );
    expect(receivedEnv).toEqual({ TOKEN: "secret", EMPTY: "" });
  });

  it("flushes incomplete trailing UTF-8 from command execution", async () => {
    const id = "utf8-command";
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        return {
          id,
          events: new ReadableStream({
            start(controller) {
              controller.enqueue({ id, seq: 1, name: "stdout", value: new Uint8Array([0xe2]) });
              controller.enqueue({ id, seq: 2, name: "exit", code: 0 });
              controller.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: async () => undefined,
    };
    const backend: WorkspaceBackend = {
      id: "command",
      type: "fake",
      async connect() {
        return { rpc: { sync: fakeRpc(), shell }, sync: "none", close: async () => undefined };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const execution = await ws.runtime.exec("printf", { encoding: "utf8" });
    await expect(execution.result()).resolves.toMatchObject({ stdout: "�", exitCode: 0 });
  });

  it("reports command executions killed through runtime as cancelled", async () => {
    const controllers: Array<
      ReadableStreamDefaultController<import("@cloudflare/computer-rpc").ExecEvent>
    > = [];
    const id = "cancel-command";
    let exit: import("@cloudflare/computer-rpc").ExecEvent | undefined;
    const events = () =>
      new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
        start(controller) {
          if (exit) {
            controller.enqueue(exit);
            controller.close();
          } else controllers.push(controller);
        },
      });
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        return { id, events: events() };
      },
      async getExec() {
        return { id, events: events() };
      },
      async killExec() {
        exit = { id, seq: 1, name: "exit", code: 143 };
        for (const controller of controllers) {
          controller.enqueue(exit);
          controller.close();
        }
        controllers.length = 0;
      },
      disposeExec: async () => undefined,
    };
    const backend: WorkspaceBackend = {
      id: "command",
      type: "fake",
      async connect() {
        return { rpc: { sync: fakeRpc(), shell }, sync: "none", close: async () => undefined };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const execution = await ws.runtime.exec("sleep 60");
    await ws.runtime.killExec(id);
    await expect(execution.result()).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 143,
    });
    const replay = await ws.runtime.getExec(id);
    await expect(replay.result()).resolves.toMatchObject({ status: "cancelled", exitCode: 143 });
  });

  it("memoizes module results and enforces single-consumer handles", async () => {
    const sourceEvents = () =>
      new ReadableStream<import("./runtime/types.js").WorkspaceRuntimeEvent>({
        start(controller) {
          controller.enqueue({
            id: "module-exec",
            seq: 1,
            name: "stdout",
            value: new TextEncoder().encode("hello"),
          });
          controller.enqueue({
            id: "module-exec",
            seq: 2,
            name: "stdout",
            value: new Uint8Array([0xe2]),
          });
          controller.enqueue({ id: "module-exec", seq: 3, name: "exit", code: 0, result: 42 });
          controller.close();
        },
      });
    let replayCalls = 0;
    const backend: WorkspaceModuleBackend = {
      protocol: "module",
      id: "module",
      type: "test-module",
      async connect() {
        return {
          async exec() {
            return { id: "module-exec", events: sourceEvents() };
          },
          getExec: async () => {
            replayCalls += 1;
            return { id: "module-exec", events: sourceEvents() };
          },
          killExec: async () => undefined,
          disposeExec: async () => undefined,
          close: async () => undefined,
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const execution = await ws.runtime.exec("export default 42", { encoding: "utf8" });
    expect(execution.backend).toBe("module");
    const resultPromise = execution.result();
    expect(execution.result()).toBe(resultPromise);
    await expect(execution.getReader().read()).rejects.toThrow(/consumed by result/);
    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
      stdout: "hello�",
      value: 42,
    });
    expect(replayCalls).toBe(0);
  });

  it("keeps module stream decoder flush sequence numbers strictly monotonic", async () => {
    const backend: WorkspaceModuleBackend = {
      protocol: "module",
      id: "module",
      type: "test-module",
      async connect() {
        return {
          async exec() {
            return {
              id: "module-exec",
              events: new ReadableStream<import("./runtime/types.js").WorkspaceRuntimeEvent>({
                start(controller) {
                  controller.enqueue({
                    id: "module-exec",
                    seq: 1,
                    name: "stdout",
                    value: new Uint8Array([0xf0, 0x9f]),
                  });
                  controller.enqueue({ id: "module-exec", seq: 2, name: "exit", code: 0 });
                  controller.close();
                },
              }),
            };
          },
          getExec: async () => {
            throw new Error("not used");
          },
          killExec: async () => undefined,
          disposeExec: async () => undefined,
          close: async () => undefined,
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const execution = await ws.runtime.exec("export default 42", { encoding: "utf8" });
    type Collected =
      | { seq: number; name: "stdout" | "stderr"; value: unknown }
      | { seq: number; name: "exit"; code: number };
    const seen: Collected[] = [];
    for await (const event of execution) {
      seen.push(
        event.name === "exit"
          ? { seq: event.seq, name: "exit", code: event.code }
          : { seq: event.seq, name: event.name, value: event.value },
      );
    }

    expect(seen).toEqual([
      { seq: 1, name: "stdout", value: "" },
      { seq: 1.5, name: "stdout", value: "�" },
      { seq: 2, name: "exit", code: 0 },
    ]);
  });

  it("throws on an unknown backend id", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [execBackend("only", () => {})],
    });
    await ws.ready();
    await expect(ws.runtime.exec("true", { backend: "missing" })).rejects.toThrow(
      /no backend with id/,
    );
  });

  it("does not cache a failed connect() attempt", async () => {
    // A first-call failure on a named backend must leave the
    // workspace able to retry. The lazy-connect path drops the
    // in-flight entry in finally(), so the next call enters
    // connect() against a fresh attempt.
    let attempts = 0;
    const backend: WorkspaceBackend = {
      id: "flaky",
      type: "fake",
      async connect() {
        attempts++;
        if (attempts === 1) throw new Error("temporary container disconnect");
        return { rpc: composite(fakeRpc()), close: async () => {} };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await expect(ws.ready("flaky")).rejects.toThrow(/temporary container disconnect/);
    await ws.ready("flaky");
    expect(attempts).toBe(2);
  });

  it("close() releases every cached handle in parallel", async () => {
    let closedA = 0;
    let closedB = 0;
    const a: WorkspaceBackend = {
      id: "a",
      type: "fake",
      async connect() {
        return {
          rpc: composite(fakeRpc()),
          close: async () => {
            closedA++;
          },
        };
      },
    };
    const b: WorkspaceBackend = {
      id: "b",
      type: "fake",
      async connect() {
        return {
          rpc: composite(fakeRpc()),
          close: async () => {
            closedB++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [a, b] });
    await ws.ready("a");
    await ws.ready("b");
    await ws.close();
    expect(closedA).toBe(1);
    expect(closedB).toBe(1);
  });

  it("backends connect lazily on first use — ready() alone doesn't dial", async () => {
    const backend = makeBackend("only");
    const spy = vi.spyOn(backend, "connect");
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready();
    expect(spy).not.toHaveBeenCalled();
    // First exec triggers the connect.
    const execBackendVar = execBackend("only", () => {});
    const ws2 = new Workspace({
      storage: makeStorage(),
      backends: [execBackendVar],
    });
    const connectSpy = vi.spyOn(execBackendVar, "connect");
    await ws2.ready();
    expect(connectSpy).not.toHaveBeenCalled();
    await drainExec(await ws2.runtime.exec("true"));
    expect(connectSpy).toHaveBeenCalledTimes(1);
    // Second exec reuses the cached handle.
    await drainExec(await ws2.runtime.exec("true"));
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("ready(id) eagerly connects the named backend", async () => {
    const backend = execBackend("only", () => {});
    const spy = vi.spyOn(backend, "connect");
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready("only");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ready({ all: true }) connects every backend in parallel", async () => {
    const a = execBackend("a", () => {});
    const b = execBackend("b", () => {});
    const spyA = vi.spyOn(a, "connect");
    const spyB = vi.spyOn(b, "connect");
    const ws = new Workspace({ storage: makeStorage(), backends: [a, b] });
    await ws.ready({ all: true });
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
  });

  it("closes a module handle that resolves after Workspace.close", async () => {
    let resolveConnect!: (handle: Awaited<ReturnType<WorkspaceModuleBackend["connect"]>>) => void;
    const closed = vi.fn(async () => undefined);
    const backend: WorkspaceModuleBackend = {
      protocol: "module",
      id: "module",
      type: "test-module",
      connect: () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const ready = ws.ready("module");
    await Promise.resolve();
    await ws.close();
    resolveConnect({
      exec: async () => {
        throw new Error("not used");
      },
      getExec: async () => {
        throw new Error("not used");
      },
      killExec: async () => undefined,
      disposeExec: async () => undefined,
      close: closed,
    });
    await expect(ready).rejects.toThrow(/closed while backend/);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not let a stale module connection clear a newer in-flight connection", async () => {
    const resolvers: Array<
      (handle: Awaited<ReturnType<WorkspaceModuleBackend["connect"]>>) => void
    > = [];
    const backend: WorkspaceModuleBackend = {
      protocol: "module",
      id: "module",
      type: "test-module",
      connect: () => new Promise((resolve) => resolvers.push(resolve)),
    };
    const handle = () => ({
      exec: async () => {
        throw new Error("not used");
      },
      getExec: async () => {
        throw new Error("not used");
      },
      killExec: async () => undefined,
      disposeExec: async () => undefined,
      close: async () => undefined,
    });
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const stale = ws.ready("module");
    await Promise.resolve();
    await ws.close();
    const current = ws.ready("module");
    await Promise.resolve();
    resolvers[0]?.(handle());
    await expect(stale).rejects.toThrow(/closed while backend/);
    const shared = ws.ready("module");
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(handle());
    await Promise.all([current, shared]);
    expect(resolvers).toHaveLength(2);
  });

  it("closes a command handle that resolves after Workspace.close", async () => {
    let resolveConnect!: (handle: Awaited<ReturnType<WorkspaceBackend["connect"]>>) => void;
    const closed = vi.fn(async () => undefined);
    const backend: WorkspaceBackend = {
      id: "command",
      type: "test-command",
      connect: () => new Promise((resolve) => (resolveConnect = resolve)),
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const ready = ws.ready("command");
    await Promise.resolve();
    await ws.close();
    resolveConnect({ rpc: composite(fakeRpc()), close: closed });
    await expect(ready).rejects.toThrow(/closed while backend/);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("runtime accessor returns a router even before any connect", () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [execBackend("only", () => {})],
    });
    expect(ws.runtime).toBeDefined();
  });

  it("fs accessor is available immediately — no ready() needed", () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("only")] });
    expect(ws.fs).toBeDefined();
  });

  it("rejects duplicate backend ids at construction", () => {
    expect(
      () =>
        new Workspace({
          storage: makeStorage(),
          backends: [makeBackend("a"), makeBackend("a")],
        }),
    ).toThrow(/duplicate backend id/);
  });

  describe("workspace.git", () => {
    // workspace.git is an opt-in property accessor. The default
    // Workspace graph stays free of the git implementation; callers
    // that need git pass the factory from @cloudflare/computer/git.
    // The client is still lazy once configured, so touching the
    // getter does not load isomorphic-git / diff, and it works on a
    // filesystem-only Workspace because every subcommand reads and
    // writes through the local SQLite-backed VFS.
    it("throws a clear error when git is not configured", () => {
      const ws = new Workspace({ storage: makeStorage() });
      expect(() => ws.git).toThrow(/Workspace git is not configured/);
    });

    it("returns the same configured client across calls", () => {
      const ws = new Workspace({ storage: makeStorage(), git: createGitClient() });
      expect(ws.git).toBe(ws.git);
    });

    it("is available with no backend configured when a git factory is passed", async () => {
      const ws = new Workspace({ storage: makeStorage(), git: createGitClient() });
      await ws.ready();
      // help is hermetic — no dynamic imports, no fs touches.
      const res = await ws.git.cli({ argv: ["help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("usage: git");
    });

    it("`git version` runs end-to-end without ready() when configured", async () => {
      const ws = new Workspace({ storage: makeStorage(), git: createGitClient() });
      const res = await ws.git.cli({ argv: ["version"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("@cloudflare/computer");
    });
  });

  describe("workspace.artifacts", () => {
    it("exists without a binding and fails with a clear command error", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      const res = await ws.artifacts.cli({ argv: ["repo", "list"] });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("Workspace Artifacts binding is not configured");
    });
  });

  describe("without a backend", () => {
    // A Workspace constructed without backends gives callers the
    // local SQLite-backed filesystem on its own. The shell half
    // throws a clear error if anyone reaches it, so the caller is
    // not silently handed a half-working surface.
    it("constructs and exposes fs without ready() throwing", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      await ws.fs.writeFile("/a.txt", "hi");
      expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("hi");
    });

    it("throws a clear error when runtime execution is reached", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await expect(ws.runtime.exec("true")).rejects.toThrow(/no execution backend/);
    });

    it("push and pull short-circuit to zero / empty", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      await ws.fs.writeFile("/a.txt", "hi");
      expect(await ws.push()).toBe(0);
      const pulled = await ws.pull();
      expect(pulled).toEqual({ applied: 0, skipped: [] });
    });

    it("module-only push and pull are no-op synchronization", async () => {
      const backend: WorkspaceModuleBackend = {
        protocol: "module",
        id: "module",
        type: "test-module",
        async connect() {
          throw new Error("sync must not connect a module backend");
        },
      };
      const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
      expect(await ws.push()).toBe(0);
      expect(await ws.pull()).toEqual({ applied: 0, skipped: [] });
    });

    it("stub() works and fs methods round-trip through it", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      const stub = ws.stub();
      await stub.fs.writeFile("/b.txt", "hello");
      expect(await stub.fs.readFile("/b.txt", "utf8")).toBe("hello");
    });

    it("stub().runtime.exec throws the same no-backend error", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      const stub = ws.stub();
      await expect(stub.runtime.exec("true")).rejects.toThrow(/no execution backend/);
    });

    it("close() is a no-op with no backend configured", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      await ws.close();
      // ready() again still works after close.
      await ws.ready();
      await ws.fs.writeFile("/c.txt", "again");
      expect(await ws.fs.readFile("/c.txt", "utf8")).toBe("again");
    });
  });
  it("drops the cached handle when the backend signals closed", async () => {
    // The backend hands back a controllable `closed` promise; resolving
    // it is how a real backend tells the Workspace "the transport is
    // gone". The cached entry for that backend id is removed; the next
    // exec / push / pull re-enters connect() against a fresh transport.
    let signalClosed!: () => void;
    let closeCount = 0;
    let connectCount = 0;
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connectCount++;
        const closed = new Promise<void>((resolve) => {
          signalClosed = resolve;
        });
        return {
          rpc: composite(fakeRpc()),
          closed,
          close: async () => {
            closeCount++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready("only");
    expect(connectCount).toBe(1);

    // Simulate a mid-session WebSocket drop.
    signalClosed();
    await new Promise((r) => setTimeout(r, 0));

    // Workspace does not call close() itself when the backend's own
    // closed promise fires — the transport is already gone.
    expect(closeCount).toBe(0);

    // The next ready(id) rebuilds.
    await ws.ready("only");
    expect(connectCount).toBe(2);
  });

  it("push() rebuilds after the backend signals closed", async () => {
    // After a transport drop the Workspace removes the cached
    // handle for that backend id. The next push() call must
    // re-enter the lazy connect path and ship against the fresh
    // handle rather than throwing.
    let signalClosed!: () => void;
    let connectCount = 0;
    const backend: WorkspaceBackend = {
      id: "reconnect",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connectCount += 1;
        const closed =
          connectCount === 1
            ? new Promise<void>((resolve) => {
                signalClosed = resolve;
              })
            : undefined;
        return {
          rpc: composite(fakeRpc()),
          closed,
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready("reconnect");
    expect(connectCount).toBe(1);

    signalClosed();
    await new Promise((r) => setTimeout(r, 0));

    // Should rebuild silently and resolve to a push count, not throw.
    const pushed = await ws.push();
    expect(pushed).toBeGreaterThanOrEqual(0);
    expect(connectCount).toBe(2);
  });

  it("reconciles watermarks on the lazy connect when the remote is behind", async () => {
    let watermarksCalls = 0;
    const sync: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async watermarks() {
        watermarksCalls++;
        return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
      },
    };
    const storage = makeStorage();
    const ws = new Workspace({ storage, backends: [makeBackend("only", sync)] });
    // Pre-seed local watermarks for the "only" backend.
    const { readFetchCursor, readWatermark, writeFetchCursor, writeWatermark } = await import(
      "@cloudflare/dofs"
    );
    writeWatermark(ws.db, "pushRev", 17, "only");
    writeFetchCursor(ws.db, { rev: 42, path: null }, "only");
    // ready() alone no longer dials; ready(id) forces the connect.
    await ws.ready("only");
    expect(watermarksCalls).toBe(1);
    expect(readWatermark(ws.db, "pushRev", "only")).toBe(0);
    expect(readFetchCursor(ws.db, "only")).toEqual({ rev: 0, path: null });
  });

  it("skips push/pull when the backend declares sync: 'none'", async () => {
    // A backend with no remote store (a worker-isolate shell
    // talking back to the same Durable Object filesystem)
    // declares sync: "none" on its BackendHandle. Workspace.push
    // and Workspace.pull short-circuit and the reconcile pass on
    // connect is skipped — nothing on the other end to reconcile
    // against.
    const touched: string[] = [];
    const tripwire = (name: string): never => {
      touched.push(name);
      throw new Error(`sync.${name} must not be reached when sync: 'none'`);
    };
    const sync: import("@cloudflare/computer-rpc").SyncRPC = {
      push: () => tripwire("push"),
      fetchChanges: () => tripwire("fetchChanges"),
      readEntry: () => tripwire("readEntry"),
      hasObjects: () => tripwire("hasObjects"),
      fetchObjects: () => {
        try {
          tripwire("fetchObjects");
        } catch (error) {
          // tripwire above pushes onto `touched` before throwing,
          // so the assertion still surfaces the wire touch.
          return new ReadableStream({
            start(c) {
              c.error(error);
            },
          });
        }
        return new ReadableStream();
      },
      pushObjects: () => tripwire("pushObjects"),
      watermarks: () => tripwire("watermarks"),
    };
    const backend: WorkspaceBackend = {
      id: "no-sync",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        return { rpc: composite(sync), sync: "none", close: async () => {} };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready("no-sync");
    expect(touched).toEqual([]);

    await ws.fs.writeFile("/local.txt", "hello");
    const pushed = await ws.push();
    const pulled = await ws.pull();
    expect(pushed).toBe(0);
    expect(pulled.applied).toBe(0);
    expect(pulled.skipped).toEqual([]);
    expect(touched).toEqual([]);
  });
});

describe("Workspace.fs against the local store", () => {
  it("writeFile then readFile round-trips bytes", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "hello workspace");
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("hello workspace");
  });

  it("writeFile chunks a > 512 KiB payload and readFile reassembles it", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    // Two-chunk payload: 600 KiB > 512 KiB chunk size.
    const bytes = new Uint8Array(600 * 1024);
    for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i & 0xff;
    await ws.fs.writeFile("/big.bin", bytes);
    const back = new Uint8Array(await new Response(await ws.fs.readFile("/big.bin")).arrayBuffer());
    expect(back.byteLength).toBe(bytes.byteLength);
    // Spot-check a few bytes; full equality elsewhere would
    // dominate the test runtime.
    expect(back[0]).toBe(bytes[0]);
    expect(back[bytes.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
    expect(back[300_000]).toBe(bytes[300_000]);
  });

  it("readFile throws ENOENT for an absent path", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await expect(ws.fs.readFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stat returns the documented shape for a file", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "hi");
    const s = await ws.fs.stat("/a.txt");
    expect(s).toMatchObject({ name: "a.txt", size: 2, isFile: true, isDirectory: false });
    expect(typeof s.mode).toBe("number");
    expect(typeof s.mtime).toBe("number");
  });

  it("stat throws ENOENT for an absent path", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await expect(ws.fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writeFile with empty content produces a zero-chunk entry", async () => {
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    await ws.fs.writeFile("/empty.txt", "");
    const bytes = new Uint8Array(
      await new Response(await ws.fs.readFile("/empty.txt")).arrayBuffer(),
    );
    expect(bytes.byteLength).toBe(0);
  });
});

describe("Workspace.pull return shape", () => {
  it("resolves to the dofs ApplyResult shape", async () => {
    // The fake SyncRPC's fetchChanges returns an empty stream, so
    // applied is 0 and skipped is []. The point of the test isn't
    // counts but the shape: pull() now returns the structured
    // result so callers can read skipped[] without an extra
    // round trip.
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake")] });
    await ws.ready();
    const result = await ws.pull();
    expect(result).toEqual({ applied: 0, skipped: [] });
  });
});

describe("Workspace mutation serialization", () => {
  it("serializes concurrent push() / pull() through a per-Workspace FIFO", async () => {
    // Build a fake SyncRPC that gates push and pull on releaser
    // promises. Two concurrent push() calls on the same Workspace
    // should queue: the second can't enter pushOnce until the first
    // releases. Without the FIFO, both would be live at once.
    const inFlight = { push: 0, pull: 0 };
    const peakInFlight = { push: 0, pull: 0 };
    let releasePush1: (() => void) | undefined;
    let releasePush2: (() => void) | undefined;
    let pushCallCount = 0;
    const releases = [
      new Promise<void>((r) => {
        releasePush1 = r;
      }),
      new Promise<void>((r) => {
        releasePush2 = r;
      }),
    ];
    const rpc: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async push(input) {
        inFlight.push++;
        peakInFlight.push = Math.max(peakInFlight.push, inFlight.push);
        const which = pushCallCount++;
        await releases[which];
        // Drain the changes stream so the wire shape is preserved.
        const reader = input.changes.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
        inFlight.push--;
        return { rev: 0, appliedPushCursor: { rev: input.senderRev, path: null } };
      },
    };

    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake", rpc)] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "a");

    // Fire two concurrent push() calls. Without the FIFO, both
    // enter pushOnce simultaneously and peakInFlight.push hits 2.
    const a = ws.push();
    const b = ws.push();
    // Let the event loop settle so any concurrent entries register.
    await new Promise((r) => setTimeout(r, 20));
    expect(peakInFlight.push).toBe(1);
    releasePush1?.();
    await a;
    releasePush2?.();
    await b;
    expect(peakInFlight.push).toBe(1);
    void inFlight.pull;
    void peakInFlight.pull;
  });

  it("reads bypass the FIFO", async () => {
    // While a push() is held in flight, reads on the local store
    // must still resolve. The FIFO only gates mutating entry points.
    let releasePush: (() => void) | undefined;
    const rpc: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async push(input) {
        await new Promise<void>((r) => {
          releasePush = r;
        });
        const reader = input.changes.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
        return { rev: 0, appliedPushCursor: { rev: input.senderRev, path: null } };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [makeBackend("fake", rpc)] });
    await ws.ready();
    await ws.fs.writeFile("/a.txt", "hello");
    const push = ws.push();
    // Wait a beat so push reaches the gated remote.push call.
    await new Promise((r) => setTimeout(r, 20));
    // Read while push is still in flight; must resolve fast.
    const read = await Promise.race([
      ws.fs.readFile("/a.txt", "utf8"),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("read blocked")), 100)),
    ]);
    expect(read).toBe("hello");
    releasePush?.();
    await push;
  });
});

describe("Workspace transport-failure invalidation", () => {
  it("push() reconnects and succeeds within the same call", async () => {
    let connects = 0;
    let closes = 0;
    const replacement = fakeRpc();
    const stale: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async push() {
        throw new WorkspaceTransportError("WebSocket closed");
      },
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        const sync = connects++ === 0 ? stale : replacement;
        return {
          rpc: composite(sync),
          closed: new Promise<void>(() => {}),
          close: async () => {
            closes++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.fs.writeFile("/a.txt", "hi");

    await expect(ws.push()).resolves.toBeGreaterThan(0);
    expect(connects).toBe(2);
    expect(closes).toBe(1);
    await expect(replacement.readEntry("/a.txt")).resolves.toMatchObject({
      kind: "file",
      path: "/a.txt",
    });
  });

  it("waits for stale handle close before sharing the reconnect", async () => {
    let connects = 0;
    let releaseClose: (() => void) | undefined;
    let closeStarted: (() => void) | undefined;
    const closeBegan = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const stale: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async push() {
        throw new WorkspaceTransportError("WebSocket closed");
      },
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        const sync = connects++ === 0 ? stale : fakeRpc();
        return {
          rpc: composite(sync),
          close: async () => {
            closeStarted?.();
            await new Promise<void>((resolve) => {
              releaseClose = resolve;
            });
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.fs.writeFile("/a.txt", "hi");

    const push = ws.push();
    await closeBegan;
    const ready = ws.ready("only");
    await Promise.resolve();
    expect(connects).toBe(1);

    releaseClose?.();
    await Promise.all([push, ready]);
    expect(connects).toBe(2);
  });

  it("pull() reconnects and succeeds within the same call", async () => {
    let connects = 0;
    let closes = 0;
    const stale: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async fetchChanges() {
        throw new WorkspaceTransportError("RPC session was shut down");
      },
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        const sync = connects++ === 0 ? stale : fakeRpc();
        return {
          rpc: composite(sync),
          closed: new Promise<void>(() => {}),
          close: async () => {
            closes++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });

    await expect(ws.pull()).resolves.toEqual({ applied: 0, skipped: [] });
    expect(connects).toBe(2);
    expect(closes).toBe(1);
  });

  it("retries a readiness failure before dispatching the sync operation", async () => {
    let connects = 0;
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connects++;
        if (connects === 1) {
          throw new WorkspaceTransportError(
            "CloudflareContainerBackend(only): connect failed at stage=health",
          );
        }
        return { rpc: composite(fakeRpc()), close: async () => {} };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.fs.writeFile("/ready.txt", "ready");

    await expect(ws.push()).resolves.toBeGreaterThan(0);
    expect(connects).toBe(2);
  });

  it("closes an unpublished handle when watermark reconciliation fails", async () => {
    let connects = 0;
    let closes = 0;
    const broken: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async watermarks() {
        throw new WorkspaceTransportError("WebSocket closed during reconcile");
      },
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        const sync = connects++ === 0 ? broken : fakeRpc();
        return {
          rpc: composite(sync),
          close: async () => {
            closes++;
          },
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });

    await expect(ws.pull()).resolves.toEqual({ applied: 0, skipped: [] });
    expect(connects).toBe(2);
    expect(closes).toBe(1);
  });

  it("preserves the terminal cause when reconnect retry is exhausted", async () => {
    let connects = 0;
    const errors = [
      new WorkspaceTransportError("first session closed"),
      new WorkspaceTransportError("replacement was not ready"),
    ];
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        throw errors[connects++];
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });

    const error = await ws.pull().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceTransportError);
    expect(error).toMatchObject({ cause: errors[1] });
    expect(String(error)).toMatch(/pull failed after 1 reconnect retry/);
    expect(String(error)).toMatch(/first session closed/);
    expect(String(error)).toMatch(/replacement was not ready/);
    expect(connects).toBe(2);
  });

  it("non-transport errors do not invalidate the cached handle", async () => {
    let connects = 0;
    const sync: import("@cloudflare/computer-rpc").SyncRPC = {
      ...fakeRpc(),
      async push() {
        throw new Error("EROFS: read-only file system");
      },
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connects++;
        return {
          rpc: composite(sync),
          closed: new Promise<void>(() => {}),
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await ws.ready("only");
    expect(connects).toBe(1);
    await ws.fs.writeFile("/a.txt", "hi");
    await expect(ws.push()).rejects.toThrow(/EROFS/);
    // Cache survives a non-transport error.
    await ws.push().catch(() => undefined);
    expect(connects).toBe(1);
  });

  it("shell.exec invalidates the cached handle on a transport error", async () => {
    let connects = 0;
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        throw new WorkspaceTransportError("RPC session was shut down");
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connects++;
        return {
          rpc: { sync: fakeRpc(), shell },
          sync: "none",
          closed: new Promise<void>(() => {}),
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    await expect(ws.runtime.exec("true")).rejects.toThrow(/RPC session was shut down/);
    expect(connects).toBe(1);
    await ws.runtime.exec("true").catch(() => undefined);
    expect(connects).toBe(2);
  });

  it("shell.exec invalidates the cached handle on a mid-stream transport error", async () => {
    // The exec dispatch succeeds; the event stream errors later
    // with a transport-classified failure. This is the realistic
    // case when a long-running command loses its WebSocket
    // mid-run — result() rejects with the transport error, and
    // the wrap around the returned handle must invalidate the
    // cached backend handle so the next operation reconnects.
    let connects = 0;
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec(input) {
        const execId = input.id ?? "mid-stream";
        return {
          id: execId,
          events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
            start(c) {
              c.error(new WorkspaceTransportError("WebSocket closed mid-stream"));
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connects++;
        return {
          rpc: { sync: fakeRpc(), shell },
          sync: "none",
          closed: new Promise<void>(() => {}),
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });
    const handle = await ws.runtime.exec("sleep 60");
    await expect(handle.result()).rejects.toThrow(/WebSocket closed mid-stream/);
    expect(connects).toBe(1);
    // Next exec attempt must reconnect.
    await ws.runtime.exec("true").catch(() => undefined);
    expect(connects).toBe(2);
  });

  it("a late mid-stream rejection from an old handle does not clobber a newer one", async () => {
    // Sequence under test:
    //  1. exec dispatches against connection A. Its event stream
    //     stays pending.
    //  2. connection A's `closed` promise fires — the Workspace
    //     drops its cached handle. Next exec reconnects to B.
    //  3. connection A's stream finally rejects with a transport
    //     error (the late settle the production code is defending
    //     against). The wrap around A's handle must invalidate
    //     the entry only if it is still A; B must survive, and a
    //     subsequent operation must NOT trigger a third connect.
    let connects = 0;
    let signalClosedA: (() => void) | null = null;
    // Per-exec stream controllers so each handle's stream can be
    // settled independently. Indexed by exec call order.
    const execStreams: ReadableStreamDefaultController<
      import("@cloudflare/computer-rpc").ExecEvent
    >[] = [];
    const shell: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec(input) {
        const execId = input.id ?? `exec-${execStreams.length}`;
        return {
          id: execId,
          events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
            start(c) {
              execStreams.push(c);
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    const backend: WorkspaceBackend = {
      id: "only",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connects++;
        const isFirst = connects === 1;
        const closed = new Promise<void>((resolve) => {
          if (isFirst) signalClosedA = resolve;
        });
        return {
          rpc: { sync: fakeRpc(), shell },
          sync: "none",
          closed,
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({ storage: makeStorage(), backends: [backend] });

    // Dispatch against connection A; its stream stays pending.
    const handleA = await ws.runtime.exec("sleep 60");
    expect(connects).toBe(1);
    const streamA = execStreams[0];

    // Connection A's transport closes. The Workspace's `closed`
    // watcher drops the cached handle on the next microtask.
    signalClosedA?.();
    await new Promise((r) => setTimeout(r, 0));

    // Next exec forces a fresh connection B.
    const handleB = await ws.runtime.exec("true");
    expect(connects).toBe(2);
    const streamB = execStreams[1];

    // NOW connection A's stream finally rejects. handleA.result()
    // surfaces the rejection, and the wrap around handleA must
    // identity-check against connection A's BackendHandle. The
    // cache currently holds connection B; invalidation must be a
    // no-op.
    streamA?.error(new WorkspaceTransportError("WebSocket closed mid-stream"));
    await expect(handleA.result()).rejects.toThrow(/WebSocket closed mid-stream/);

    // The next operation must reuse connection B — i.e. NOT
    // reconnect again. Without the fix, A's late rejection would
    // have invalidated B's slot and this third exec would force a
    // third connect.
    const handleC = await ws.runtime.exec("true");
    expect(connects).toBe(2);
    const streamC = execStreams[2];

    // Settle B's and C's streams cleanly so the test doesn't leak
    // pending readers.
    streamB?.close();
    streamC?.close();
    await Promise.all([
      handleB.result().catch(() => undefined),
      handleC.result().catch(() => undefined),
    ]);
  });
});
describe("Workspace Think compatibility", () => {
  it("adds Think-compatible filesystem methods when useThink is true", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      useThink: true,
      now: () => 1_700_000_000_000,
    });

    expectThinkWorkspace(ws);

    await ws.mkdir("/workspace/notes", { recursive: true });
    await ws.writeFile("/workspace/notes/a.txt", "hello");
    await ws.writeFile("/workspace/notes/b.md", "# title");

    expect(await ws.readFile("/workspace/notes/a.txt")).toBe("hello");
    expect(await ws.readFile("/workspace/missing.txt")).toBeNull();
    expect(new TextDecoder().decode(await ws.readFileBytes("/workspace/notes/a.txt"))).toBe(
      "hello",
    );
    expect(await ws.readFileBytes("/workspace/missing.txt")).toBeNull();

    await expect(ws.stat("/workspace/notes/a.txt")).resolves.toMatchObject({
      path: "/workspace/notes/a.txt",
      name: "a.txt",
      type: "file",
      size: 5,
    });
    await expect(ws.stat("/workspace/missing.txt")).resolves.toBeNull();

    await expect(ws.readDir("/workspace/notes", { limit: 1, offset: 1 })).resolves.toEqual([
      expect.objectContaining({ path: "/workspace/notes/b.md", name: "b.md", type: "file" }),
    ]);
    await expect(ws.glob("/workspace/notes/**/*.txt")).resolves.toEqual([
      expect.objectContaining({ path: "/workspace/notes/a.txt", name: "a.txt", type: "file" }),
    ]);

    await ws.rm("/workspace/notes/a.txt", { force: true });
    expect(await ws.readFile("/workspace/notes/a.txt")).toBeNull();
  });

  it("does not add Think compatibility methods by default", () => {
    const ws = new Workspace({ storage: makeStorage() });

    expect(ws).not.toHaveProperty("readFile");
    expect(ws).not.toHaveProperty("readFileBytes");
    expect(ws).not.toHaveProperty("writeFile");
    expect(ws).not.toHaveProperty("readDir");
    expect(ws).not.toHaveProperty("glob");
    expect(ws).not.toHaveProperty("mkdir");
    expect(ws).not.toHaveProperty("rm");
    expect(ws).not.toHaveProperty("stat");
  });
});
