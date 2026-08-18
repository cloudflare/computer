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

import { getWorkspace } from "./client.js";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace.js";
import { Workspace } from "./workspace.js";

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

function fakeLegacyFlagRemote(): {
  host: WorkspaceStubHost;
  disposed: () => boolean;
} {
  const { runtime } = fakeRuntime(true);
  let disposed = false;
  const stub = {
    fs: { marker: "fs" },
    runtime,
    git: { marker: "git" },
    assets: undefined,
    artifacts: { marker: "artifacts" },
    get useThink(): boolean {
      throw new Error("legacy compatibility flag was read");
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

describe("getWorkspace — remote dispatch", () => {
  it("calls __getWorkspaceStub and exposes the stub's members", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    expect(ws.fs).toEqual({ marker: "fs" });
    expect(ws.git).toEqual({ marker: "git" });
    expect(ws.artifacts).toEqual({ marker: "artifacts" });
    expect(ws).not.toHaveProperty("readFile");
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

  it("does not inspect the removed remote useThink flag", async () => {
    const { host, disposed } = fakeLegacyFlagRemote();

    const ws = await getWorkspace(host);
    expect(ws.fs).toEqual({ marker: "fs" });
    expect(disposed()).toBe(false);
    ws[Symbol.dispose]();
    expect(disposed()).toBe(true);
  });
});

describe("getWorkspace — local dispatch", () => {
  it("delegates to the in-isolate Workspace via the symbol stash", async () => {
    const { host, calls } = fakeLocal();
    const ws = await getWorkspace(host);
    await ws.runtime.exec`cat ${"my file.txt"}`;
    expect(calls[0].command).toBe("cat 'my file.txt'");
    expect(ws).not.toHaveProperty("readFile");
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
