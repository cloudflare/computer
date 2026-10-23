// Unit tests for getWorkspace and the client's runtime.exec forms.
//
// Two dispatch paths: a local host carrying the symbol-stashed
// Workspace (getWorkspace(this)), and a remote stub exposing
// __getWorkspaceStub (getWorkspace(env.MyDO.get(id))). Both must yield
// the same client surface and the same runtime.exec behavior. These
// tests use fakes for both paths so the dispatch and the local
// escaping are pinned without standing up workerd.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { WorkerJavaScriptBackend } from "./backends/worker-javascript/worker-javascript";
import { getWorkspace } from "./client";
import type { WorkspaceBackendInfo } from "./runtime/runtime";
import type { WorkspaceModuleBackend } from "./runtime/types";
import { createAITools } from "./tools/ai-sdk/index";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace";
import { Workspace } from "./workspace";

interface ExecCall {
  command: string;
  options: Record<string, unknown> | undefined;
}

// A fake runtime that records exec calls. Stands in for both
// Workspace.runtime (local) and the runtime stub (remote) — the client
// only needs `exec(command, options?)`.
function fakeRuntime(promisedProperties = false) {
  const calls: ExecCall[] = [];
  let disposedHandles = 0;
  // A minimal handle satisfying both the local identity rehydrate
  // (which passes it through) and the remote rebuild (which calls
  // stream()/result()/kill()). stream() emits one JSONL exit frame so
  // the rebuilt handle can be iterated.
  const makeHandle = (id = "x", backend = "test") => ({
    id: promisedProperties ? Promise.resolve(id) : id,
    backend: promisedProperties ? Promise.resolve(backend) : backend,
    result: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    stream: () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(`${JSON.stringify({ id, seq: 0, name: "exit", code: 0 })}\n`),
          );
          c.close();
        },
      });
      return promisedProperties ? Promise.resolve(stream) : stream;
    },
    kill: () => Promise.resolve(),
    [Symbol.dispose]() {
      disposedHandles += 1;
    },
  });
  return {
    calls,
    disposedHandles: () => disposedHandles,
    runtime: {
      exec(command: string, options?: Record<string, unknown>) {
        calls.push({ command, options });
        return Promise.resolve(
          makeHandle(options?.id as string | undefined, options?.backend as string | undefined),
        );
      },
      getExec(id: string, options?: Record<string, unknown>) {
        calls.push({ command: `get:${id}`, options });
        return Promise.resolve(makeHandle(id, options?.backend as string | undefined));
      },
      killExec(id: string, options?: Record<string, unknown>) {
        calls.push({ command: `kill:${id}`, options });
        return Promise.resolve();
      },
      disposeExec(id: string, options?: Record<string, unknown>) {
        calls.push({ command: `dispose:${id}`, options });
        return Promise.resolve();
      },
      backends() {
        return promisedProperties ? Promise.resolve([]) : [];
      },
    },
  };
}

// Remote path fake: a stub whose getters mirror WorkspaceStub and
// whose __getWorkspaceStub resolves to it.
function fakeRemote(): {
  host: WorkspaceStubHost;
  calls: ExecCall[];
  disposed: () => boolean;
  disposedHandles: () => number;
} {
  const { runtime, calls, disposedHandles } = fakeRuntime(true);
  let disposed = false;
  const stub = {
    fs: { marker: "fs" },
    git: { marker: "git" },
    assets: undefined,
    artifacts: { marker: "artifacts" },
    runtime,
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  return {
    calls,
    disposed: () => disposed,
    disposedHandles,
    host: { __getWorkspaceStub: () => Promise.resolve(stub as never) },
  };
}

function fakeBrokenRemote(): {
  host: WorkspaceStubHost;
  disposed: () => boolean;
} {
  let disposed = false;
  const stub = {
    runtime: {
      backends(): never {
        throw new Error("backend lookup failed");
      },
    },
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  return {
    disposed: () => disposed,
    host: { __getWorkspaceStub: () => Promise.resolve(stub as never) },
  };
}

// Local path fake: an object carrying a real Workspace under the
// stash symbol, but with its shell swapped for a recording fake so we
// can assert on exec without a backend.
function fakeLocal(): { host: { [WORKSPACE]: Workspace }; calls: ExecCall[] } {
  const ws = new Workspace({ storage: new SQLiteTestStorage() });
  const { runtime, calls } = fakeRuntime();
  Object.defineProperty(ws, "runtime", { get: () => runtime });
  return { calls, host: { [WORKSPACE]: ws } };
}

// A remote host that counts how often it is reached and can fail on
// chosen attempts, for the lazy client tests.
function countingRemote(failOn: number[] = []) {
  const { runtime, calls } = fakeRuntime(true);
  let reached = 0;
  let disposed = 0;
  const stub = {
    fs: { stat: (path: string) => Promise.resolve({ path }) },
    git: { cli: (input: unknown) => Promise.resolve({ input }) },
    hasAssets: false,
    artifacts: { list: () => Promise.resolve(["repo"]) },
    runtime,
    [Symbol.dispose]() {
      disposed += 1;
    },
  };
  const host: WorkspaceStubHost = {
    __getWorkspaceStub: () => {
      reached += 1;
      if (failOn.includes(reached)) return Promise.reject(new Error("owner unavailable"));
      return Promise.resolve(stub as never);
    },
  };
  return { host, calls, reached: () => reached, disposed: () => disposed };
}

describe("getWorkspace — lazy client", () => {
  it("returns a client without reaching the durable object", async () => {
    const remote = countingRemote();
    const ws = getWorkspace(remote.host);
    expect(remote.reached()).toBe(0);
    await expect(ws.fs.stat("/a")).resolves.toEqual({ path: "/a" });
    expect(remote.reached()).toBe(1);
  });

  it("reaches the durable object once across calls", async () => {
    const remote = countingRemote();
    const ws = getWorkspace(remote.host);
    await Promise.all([ws.fs.stat("/a"), ws.git.cli({ args: ["status"] }), ws.artifacts.list()]);
    await ws.fs.stat("/b");
    expect(remote.reached()).toBe(1);
  });

  it("looks up a handle from a function on the first call", async () => {
    const remote = countingRemote();
    let looked = 0;
    const ws = getWorkspace(async () => {
      looked += 1;
      return remote.host;
    });
    expect(looked).toBe(0);
    await expect(ws.fs.stat("/a")).resolves.toEqual({ path: "/a" });
    await ws.fs.stat("/b");
    expect(looked).toBe(1);
  });

  it("calls the function again after it fails", async () => {
    const remote = countingRemote();
    let looked = 0;
    const ws = getWorkspace(() => {
      looked += 1;
      if (looked === 1) throw new Error("not a facet yet");
      return remote.host;
    });
    await expect(ws.fs.stat("/a")).rejects.toThrow("not a facet yet");
    await expect(ws.fs.stat("/a")).resolves.toEqual({ path: "/a" });
    expect(looked).toBe(2);
  });

  it("tries again after a failed load", async () => {
    const remote = countingRemote([1]);
    const ws = getWorkspace(remote.host);
    await expect(ws.fs.stat("/a")).rejects.toThrow("owner unavailable");
    await expect(ws.fs.stat("/a")).resolves.toEqual({ path: "/a" });
    expect(remote.reached()).toBe(2);
  });

  it("runs commands before it has loaded", async () => {
    const remote = countingRemote();
    const ws = getWorkspace(remote.host);
    await ws.runtime.exec`cat ${"my file.txt"}`;
    expect(remote.calls[0]?.command).toBe("cat 'my file.txt'");
  });

  it("reports no backends or assets until awaited", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [echoBackend()],
    });
    const lazy = getWorkspace({ __getWorkspaceStub: () => Promise.resolve(workspace.stub()) });
    expect(lazy.runtime.backends()).toEqual([]);
    expect(createAITools({ workspace: lazy }).exec).toBeUndefined();

    const loaded = await lazy;
    expect(loaded.runtime.backends()).toHaveLength(1);
    expect(createAITools({ workspace: loaded }).exec).toBeDefined();
    await workspace.close();
  });

  it("disposes the remote stub, and refuses calls, once disposed", async () => {
    const remote = countingRemote();
    const ws = getWorkspace(remote.host);
    await ws.fs.stat("/a");
    ws[Symbol.dispose]();
    await Promise.resolve();
    expect(remote.disposed()).toBe(1);
    await expect(ws.fs.stat("/a")).rejects.toThrow("disposed");
  });

  it("does not look like a promise through its members", () => {
    const ws = getWorkspace(countingRemote().host);
    expect((ws.fs as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

describe("getWorkspace — remote dispatch", () => {
  it("calls __getWorkspaceStub and exposes the stub's members", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    expect(ws.fs).toEqual({ marker: "fs" });
    expect(ws.git).toEqual({ marker: "git" });
    expect(ws.artifacts).toEqual({ marker: "artifacts" });
  });

  it("streams through an asynchronous remote stream result", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.runtime.exec("echo ok");
    const events = [];
    for await (const event of handle) events.push(event);
    expect(events).toEqual([{ id: expect.any(String), seq: 0, name: "exit", code: 0 }]);
  });

  it("exposes the complete runtime lifecycle and preserves handle ids", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = (await ws.runtime.getExec("run-1", { resume: "tail" })) as {
      id: string;
      backend: string;
    };
    expect(handle.id).toBe("run-1");
    expect(handle.backend).toBe("test");
    await ws.runtime.killExec("run-1", { signal: "SIGINT" });
    await ws.runtime.disposeExec("run-1", { backend: "container-shell" });
    expect(calls).toEqual([
      { command: "get:run-1", options: { resume: "tail" } },
      { command: "kill:run-1", options: { signal: "SIGINT" } },
      { command: "dispose:run-1", options: { backend: "container-shell" } },
    ]);
  });

  it("disposing the client disposes the remote stub", async () => {
    const { host, disposed } = fakeRemote();
    const ws = await getWorkspace(host);
    ws[Symbol.dispose]();
    expect(disposed()).toBe(true);
  });

  it("disposes the remote stub when client initialization fails", async () => {
    const { host, disposed } = fakeBrokenRemote();

    await expect(getWorkspace(host)).rejects.toThrow("backend lookup failed");
    expect(disposed()).toBe(true);
  });
});

describe("getWorkspace — local dispatch", () => {
  it("delegates to the in-isolate Workspace via the symbol stash", async () => {
    const { host, calls } = fakeLocal();
    const ws = await getWorkspace(host);
    await ws.runtime.exec`cat ${"my file.txt"}`;
    expect(calls[0].command).toBe("cat 'my file.txt'");
  });

  it("does not throw on dispose (the durable object owns the lifecycle)", async () => {
    const { host } = fakeLocal();
    const ws = await getWorkspace(host);
    expect(() => ws[Symbol.dispose]()).not.toThrow();
  });
});

describe("client runtime.exec — tagged template form", () => {
  it("escapes interpolated values before they reach the shell", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec`echo ${"x; rm -rf /"}`;
    expect(calls[0].command).toBe("echo 'x; rm -rf /'");
  });

  it("defaults to utf8 string output", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec`ls`;
    expect(calls[0].options).toEqual({ id: expect.any(String), encoding: "utf8" });
  });

  it("quotes each element of an interpolated array", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec`rm ${["a.txt", "b c.txt"]}`;
    expect(calls[0].command).toBe("rm a.txt 'b c.txt'");
  });
});

describe("client runtime.exec — plain string form", () => {
  it("forwards a bare command with no options", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec("npm test");
    expect(calls[0]).toEqual({
      command: "npm test",
      options: { id: expect.any(String) },
    });
  });

  it("forwards options unchanged", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec("npm test", { cwd: "/workspace", backend: "sandbox" });
    expect(calls[0]).toEqual({
      command: "npm test",
      options: { cwd: "/workspace", backend: "sandbox", id: expect.any(String) },
    });
  });

  it("does not escape a plain string command", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.runtime.exec("echo 'already quoted'");
    expect(calls[0].command).toBe("echo 'already quoted'");
  });
});

describe("client runtime.exec — remote handle rebuild", () => {
  it("rebuilds a host-shaped handle: result() returns the run-and-wait result", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.runtime.exec("echo hi");
    const result = await handle.result();
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("rebuilds an async-iterable handle that decodes the JSONL event stream", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.runtime.exec("echo hi");
    type Collected = { name: "stdout" | "stderr"; value: unknown } | { name: "exit"; code: number };
    const events: Collected[] = [];
    for await (const event of handle as AsyncIterable<Collected>) {
      events.push(
        event.name === "exit"
          ? { name: "exit", code: event.code }
          : { name: event.name, value: event.value },
      );
    }
    expect(events).toEqual([{ name: "exit", code: 0 }]);
  });

  it("throws if result() is called after the stream has started", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.runtime.exec("echo hi");
    // Start streaming, then attempt result(): the underlying handle is
    // single-shot, so this is rejected rather than silently wrong.
    const reader = (handle as ReadableStream).getReader();
    await reader.read();
    reader.releaseLock();
    expect(() => (handle as { result(): unknown }).result()).toThrow(/already streaming/);
  });

  it("disposes the remote handle when the rebuilt handle is disposed", async () => {
    const { host, disposedHandles } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.runtime.exec("echo hi");
    handle[Symbol.dispose]?.();
    expect(disposedHandles()).toBe(1);
  });
});

// A callable module backend that answers every execution with the
// structured input it was given, so a test can follow `input` from the
// exec tool through a client to the backend and back.
function echoBackend(): WorkspaceModuleBackend {
  return {
    protocol: "module",
    id: "echo",
    type: "echo",
    callable: true,
    description: "Echoes its input.",
    async connect() {
      return {
        async exec(input) {
          const id = input.id ?? "echo-1";
          return {
            id,
            events: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  id,
                  seq: 1,
                  name: "exit",
                  code: 0,
                  result: { received: input.input ?? null },
                });
                controller.close();
              },
            }),
          };
        },
        getExec: () => Promise.reject(new Error("not used")),
        killExec: () => Promise.resolve(),
        disposeExec: () => Promise.resolve(),
      };
    },
  };
}

describe("getWorkspace — backend information", () => {
  // A Workspace with one callable JavaScript backend that describes its
  // modules. The loader is never reached; only construction runs.
  function workspaceWithJavaScript() {
    return new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load: () => ({ getEntrypoint: () => ({}) }) },
          modules: { "ws:weather": { forecast: () => null } },
        }),
      ],
    });
  }

  for (const [path, connect] of [
    ["local", (ws: Workspace) => getWorkspace({ [WORKSPACE]: ws })],
    [
      "remote",
      (ws: Workspace) => getWorkspace({ __getWorkspaceStub: () => Promise.resolve(ws.stub()) }),
    ],
  ] as const) {
    it(`sends structured input through a ${path} client to a callable backend`, async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [echoBackend()],
      });
      const client = await connect(workspace);
      const exec = createAITools({ workspace: client }).exec as {
        execute?: (input: unknown, options: unknown) => AsyncIterable<unknown>;
      };
      if (!exec.execute) throw new Error("exec has no execute function");

      let last: unknown;
      for await (const snapshot of exec.execute(
        { command: "export default (input) => input", input: { value: 42 } },
        { toolCallId: "call", messages: [] },
      )) {
        last = snapshot;
      }

      expect(last).toMatchObject({
        backend: "echo",
        exitCode: 0,
        result: { received: { value: 42 } },
      });
      await workspace.close();
    });
  }

  for (const [path, connect] of [
    ["local", (ws: Workspace) => getWorkspace({ [WORKSPACE]: ws })],
    [
      "remote",
      (ws: Workspace) => getWorkspace({ __getWorkspaceStub: () => Promise.resolve(ws.stub()) }),
    ],
  ] as const) {
    it(`leaves publish out on a ${path} client without assets`, async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [echoBackend()],
      });
      const client = await connect(workspace);

      expect(client.assets).toBeUndefined();
      expect(createAITools({ workspace: client }).publish).toBeUndefined();
      await workspace.close();
    });
  }

  it("keeps its backend snapshot from being edited", async () => {
    const client = await getWorkspace({
      [WORKSPACE]: new Workspace({ storage: new SQLiteTestStorage(), backends: [echoBackend()] }),
    });
    const list = client.runtime.backends();

    expect(() => (list as WorkspaceBackendInfo[]).pop()).toThrow("Cannot delete property");
    expect(client.runtime.backends()).toHaveLength(1);
  });

  for (const [path, connect] of [
    ["local", (ws: Workspace) => getWorkspace({ [WORKSPACE]: ws })],
    [
      "remote",
      (ws: Workspace) => getWorkspace({ __getWorkspaceStub: () => Promise.resolve(ws.stub()) }),
    ],
  ] as const) {
    it(`answers backend questions on a ${path} client`, async () => {
      const client = await connect(workspaceWithJavaScript());

      const [backend, ...others] = client.runtime.backends();

      expect(others).toEqual([]);
      expect(backend).toMatchObject({ id: "worker-javascript", callable: true });
      expect(backend?.description).toContain("`ws:weather`: exports");
    });

    it(`builds a callable exec tool from a ${path} client`, async () => {
      const client = await connect(workspaceWithJavaScript());
      const tools = createAITools({ workspace: client });
      const exec = tools.exec as { description?: string; inputSchema?: unknown } | undefined;
      if (!(exec?.inputSchema instanceof z.ZodType))
        throw new Error("exec has no zod input schema");
      const schema = z.toJSONSchema(exec.inputSchema) as { properties: Record<string, unknown> };

      expect(exec.description).toContain("`ws:weather`: exports `forecast`.");
      expect(Object.keys(schema.properties)).toContain("input");
    });
  }
});
