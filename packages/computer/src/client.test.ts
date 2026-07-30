// Unit tests for getWorkspace and the client's shell.exec forms.
//
// Two dispatch paths: a local host carrying the symbol-stashed
// Workspace (getWorkspace(this)), and a remote stub exposing
// __getWorkspaceStub (getWorkspace(env.MyDO.get(id))). Both must yield
// the same client surface and the same shell.exec behavior. These
// tests use fakes for both paths so the dispatch and the local
// escaping are pinned without standing up workerd.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { getWorkspace, type WorkspaceClient } from "./client.js";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace.js";
import { type ThinkWorkspaceCompatibility, Workspace } from "./workspace.js";

interface ExecCall {
  command: string;
  options: Record<string, unknown> | undefined;
}

interface GetCall {
  id: string;
  options: Record<string, unknown> | undefined;
}

// A fake shell that records exec and get calls. Stands in for both
// Workspace.shell (local) and the shell stub (remote) — the client
// only needs `exec(command, options?)` and `get(id, options?)`.
function fakeShell(): {
  shell: {
    exec: (c: string, o?: Record<string, unknown>) => Promise<unknown>;
    get: (id: string, o?: Record<string, unknown>) => Promise<unknown>;
  };
  calls: ExecCall[];
  gets: GetCall[];
  disposedHandles: () => number;
} {
  const calls: ExecCall[] = [];
  const gets: GetCall[] = [];
  let disposedHandles = 0;
  // A minimal handle satisfying both the local identity rehydrate
  // (which passes it through) and the remote rebuild (which calls
  // stream()/result()/kill()). stream() emits one JSONL exit frame so
  // the rebuilt handle can be iterated.
  const makeHandle = () => ({
    result: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ id: "x", seq: 0, name: "exit", value: 0 })}\n`,
            ),
          );
          c.close();
        },
      }),
    kill: () => Promise.resolve(),
    [Symbol.dispose]() {
      disposedHandles += 1;
    },
  });
  return {
    calls,
    gets,
    disposedHandles: () => disposedHandles,
    shell: {
      exec(command: string, options?: Record<string, unknown>) {
        calls.push({ command, options });
        return Promise.resolve(makeHandle());
      },
      get(id: string, options?: Record<string, unknown>) {
        gets.push({ id, options });
        return Promise.resolve(makeHandle());
      },
    },
  };
}

// Remote path fake: a stub whose getters mirror WorkspaceStub and
// whose __getWorkspaceStub resolves to it.
function fakeRemote(): {
  host: WorkspaceStubHost;
  calls: ExecCall[];
  gets: GetCall[];
  disposed: () => boolean;
  disposedHandles: () => number;
} {
  const { shell, calls, gets, disposedHandles } = fakeShell();
  let disposed = false;
  const stub = {
    fs: { marker: "fs" },
    useThink: false,
    git: { marker: "git" },
    assets: undefined,
    artifacts: { marker: "artifacts" },
    shell,
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  return {
    calls,
    gets,
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
    get useThink(): boolean {
      throw new Error("compatibility lookup failed");
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
function fakeLocal(): {
  host: { [WORKSPACE]: Workspace };
  calls: ExecCall[];
  gets: GetCall[];
} {
  const ws = new Workspace({ storage: new SQLiteTestStorage() });
  const { shell, calls, gets } = fakeShell();
  Object.defineProperty(ws, "shell", { get: () => shell });
  return { calls, gets, host: { [WORKSPACE]: ws } };
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

  it("disposing the client disposes the remote stub", async () => {
    const { host, disposed } = fakeRemote();
    const ws = await getWorkspace(host);
    ws[Symbol.dispose]();
    expect(disposed()).toBe(true);
  });

  it("disposes the remote stub when client initialization fails", async () => {
    const { host, disposed } = fakeBrokenRemote();

    await expect(getWorkspace(host)).rejects.toThrow("compatibility lookup failed");
    expect(disposed()).toBe(true);
  });

  it("adds Think compatibility when the remote Workspace enables it", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      useThink: true,
    });
    await workspace.fs.writeFile("/notes.txt", "hello");
    const host: WorkspaceStubHost = {
      __getWorkspaceStub: () => Promise.resolve(workspace.stub()),
    };

    const client = (await getWorkspace(host)) as WorkspaceClient & ThinkWorkspaceCompatibility;

    expect(client).toHaveProperty("readFile");
    await expect(client.readFile("/notes.txt")).resolves.toBe("hello");
    await expect(client.readFile("/missing.txt")).resolves.toBeNull();
  });
});

describe("getWorkspace — local dispatch", () => {
  it("delegates to the in-isolate Workspace via the symbol stash", async () => {
    const { host, calls } = fakeLocal();
    const ws = await getWorkspace(host);
    await ws.shell.exec`cat ${"my file.txt"}`;
    expect(calls[0].command).toBe("cat 'my file.txt'");
    expect(ws).not.toHaveProperty("readFile");
  });

  it("does not throw on dispose (the durable object owns the lifecycle)", async () => {
    const { host } = fakeLocal();
    const ws = await getWorkspace(host);
    expect(() => ws[Symbol.dispose]()).not.toThrow();
  });

  it("adds Think compatibility when the local Workspace enables it", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      useThink: true,
    });
    const host = { [WORKSPACE]: workspace };
    const { shell } = fakeShell();
    Object.defineProperty(workspace, "shell", { get: () => shell });

    const client = (await getWorkspace(host)) as WorkspaceClient & ThinkWorkspaceCompatibility;

    expect(client).toHaveProperty("readFile");
  });
});

describe("client shell.exec — tagged template form", () => {
  it("escapes interpolated values before they reach the shell", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec`echo ${"x; rm -rf /"}`;
    expect(calls[0].command).toBe("echo 'x; rm -rf /'");
  });

  it("defaults to utf8 string output", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec`ls`;
    expect(calls[0].options).toMatchObject({ encoding: "utf8" });
  });

  it("quotes each element of an interpolated array", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec`rm ${["a.txt", "b c.txt"]}`;
    expect(calls[0].command).toBe("rm a.txt 'b c.txt'");
  });
});

describe("client shell.exec — plain string form", () => {
  it("forwards a bare command", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec("npm test");
    expect(calls[0].command).toBe("npm test");
  });

  it("forwards options unchanged", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec("npm test", { cwd: "/workspace", backend: "sandbox" });
    expect(calls[0].command).toBe("npm test");
    expect(calls[0].options).toMatchObject({ cwd: "/workspace", backend: "sandbox" });
  });

  it("does not escape a plain string command", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec("echo 'already quoted'");
    expect(calls[0].command).toBe("echo 'already quoted'");
  });
});

describe("client shell.exec — remote handle rebuild", () => {
  it("rebuilds a host-shaped handle: result() returns the run-and-wait result", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("echo hi");
    const result = await handle.result();
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("rebuilds an async-iterable handle that decodes the JSONL event stream", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("echo hi");
    const events: Array<{ name: string; value: unknown }> = [];
    for await (const event of handle as AsyncIterable<{ name: string; value: unknown }>) {
      events.push({ name: event.name, value: event.value });
    }
    expect(events).toEqual([{ name: "exit", value: 0 }]);
  });

  it("throws if result() is called after the stream has started", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("echo hi");
    // Start streaming, then attempt result(): the underlying handle is
    // single-shot, so this is rejected rather than silently wrong.
    const reader = (handle as ReadableStream).getReader();
    await reader.read();
    reader.releaseLock();
    expect(() => (handle as { result(): unknown }).result()).toThrow(/already streaming/);
  });

  it("carries the id the caller asked for onto the rebuilt handle", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("npm install", { id: "install-1" });
    expect(handle.id).toBe("install-1");
    expect(calls[0].options).toMatchObject({ id: "install-1" });
  });

  it("mints an id when the caller omits one so the handle can be reattached", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("npm install");
    // The minted id is what went over the wire, so a later
    // shell.get(handle.id) addresses this run.
    expect(typeof handle.id).toBe("string");
    expect(handle.id).not.toBe("");
    expect(calls[0].options?.id).toBe(handle.id);
  });

  it("disposes the remote handle when the rebuilt handle is disposed", async () => {
    const { host, disposedHandles } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("echo hi");
    handle[Symbol.dispose]?.();
    expect(disposedHandles()).toBe(1);
  });
});

describe("client shell.get — reattach", () => {
  it("reattaches over RPC and rebuilds a handle carrying the run's id", async () => {
    const { host, gets } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.get("install-1", { encoding: "utf8", resume: "tail" });
    expect(gets[0]).toEqual({
      id: "install-1",
      options: { encoding: "utf8", resume: "tail" },
    });
    expect(handle.id).toBe("install-1");
    const result = await handle.result();
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("delegates to the in-isolate Workspace on the local path", async () => {
    const { host, gets } = fakeLocal();
    const ws = await getWorkspace(host);
    await ws.shell.get("install-1", { resume: 12 });
    expect(gets[0]).toEqual({ id: "install-1", options: { resume: 12 } });
  });
});
