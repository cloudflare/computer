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

import { getWorkspace } from "./client.js";
import { WORKSPACE, type WorkspaceStubHost } from "./with-workspace.js";
import { Workspace } from "./workspace.js";

interface ExecCall {
  command: string;
  options: Record<string, unknown> | undefined;
}

// A fake shell that records exec calls. Stands in for both
// Workspace.shell (local) and the shell stub (remote) — the client
// only needs `exec(command, options?)`.
function fakeShell(): {
  shell: { exec: (c: string, o?: Record<string, unknown>) => Promise<unknown> };
  calls: ExecCall[];
  disposedHandles: () => number;
} {
  const calls: ExecCall[] = [];
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
    disposedHandles: () => disposedHandles,
    shell: {
      exec(command: string, options?: Record<string, unknown>) {
        calls.push({ command, options });
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
  disposed: () => boolean;
  disposedHandles: () => number;
} {
  const { shell, calls, disposedHandles } = fakeShell();
  let disposed = false;
  const stub = {
    fs: { marker: "fs" },
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
    disposed: () => disposed,
    disposedHandles,
    host: { __getWorkspaceStub: () => Promise.resolve(stub as never) },
  };
}

// Local path fake: an object carrying a real Workspace under the
// stash symbol, but with its shell swapped for a recording fake so we
// can assert on exec without a backend.
function fakeLocal(): { host: { [WORKSPACE]: Workspace }; calls: ExecCall[] } {
  const ws = new Workspace({ storage: new SQLiteTestStorage() });
  const { shell, calls } = fakeShell();
  Object.defineProperty(ws, "shell", { get: () => shell });
  return { calls, host: { [WORKSPACE]: ws } };
}

describe("getWorkspace — remote dispatch", () => {
  it("calls __getWorkspaceStub and exposes the stub's members", async () => {
    const { host } = fakeRemote();
    const ws = await getWorkspace(host);
    expect(ws.fs).toEqual({ marker: "fs" });
    expect(ws.git).toEqual({ marker: "git" });
    expect(ws.artifacts).toEqual({ marker: "artifacts" });
  });

  it("disposing the client disposes the remote stub", async () => {
    const { host, disposed } = fakeRemote();
    const ws = await getWorkspace(host);
    ws[Symbol.dispose]();
    expect(disposed()).toBe(true);
  });
});

describe("getWorkspace — local dispatch", () => {
  it("delegates to the in-isolate Workspace via the symbol stash", async () => {
    const { host, calls } = fakeLocal();
    const ws = await getWorkspace(host);
    await ws.shell.exec`cat ${"my file.txt"}`;
    expect(calls[0].command).toBe("cat 'my file.txt'");
  });

  it("does not throw on dispose (the durable object owns the lifecycle)", async () => {
    const { host } = fakeLocal();
    const ws = await getWorkspace(host);
    expect(() => ws[Symbol.dispose]()).not.toThrow();
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
    expect(calls[0].options).toEqual({ encoding: "utf8" });
  });

  it("quotes each element of an interpolated array", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec`rm ${["a.txt", "b c.txt"]}`;
    expect(calls[0].command).toBe("rm a.txt 'b c.txt'");
  });
});

describe("client shell.exec — plain string form", () => {
  it("forwards a bare command with no options", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec("npm test");
    expect(calls[0]).toEqual({ command: "npm test", options: undefined });
  });

  it("forwards options unchanged", async () => {
    const { host, calls } = fakeRemote();
    const ws = await getWorkspace(host);
    await ws.shell.exec("npm test", { cwd: "/workspace", backend: "sandbox" });
    expect(calls[0]).toEqual({
      command: "npm test",
      options: { cwd: "/workspace", backend: "sandbox" },
    });
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

  it("disposes the remote handle when the rebuilt handle is disposed", async () => {
    const { host, disposedHandles } = fakeRemote();
    const ws = await getWorkspace(host);
    const handle = await ws.shell.exec("echo hi");
    handle[Symbol.dispose]?.();
    expect(disposedHandles()).toBe(1);
  });
});
