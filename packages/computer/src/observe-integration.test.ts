// Integration tests for the observer hook on the public Workspace
// surface. Each test wires a recording observer into a Workspace built
// against in-process fakes and asserts on the resulting span names and
// attributes. The recorder lives in `./observe.test.ts` and is shared
// across both files.

import type { SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { makeRecorder, type RecordedSpan } from "./observe-recorder.js";
import { WorkspaceFilesystemStub, WorkspaceShellStub } from "./stub.js";
import { Workspace } from "./workspace.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

// Minimal fake SyncRPC. push() and pull() succeed with no changes so the
// observer-side tests can focus on span shape rather than apply logic.
function fakeSync(): SyncRPC {
  return {
    async push(input) {
      // Drain the changes stream to satisfy the wire contract; the fake
      // does not persist anything because the assertion is on spans, not
      // on apply behaviour.
      const reader = input.changes.getReader();
      try {
        while (!(await reader.read()).done) {
          // discard
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
    async readEntry() {
      return null;
    },
    async hasObjects(hashes) {
      return hashes;
    },
    fetchObjects() {
      return new ReadableStream({
        start(c) {
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
        while (!(await reader.read()).done) {
          // discard
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function composite(sync: SyncRPC): WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  return {
    sync,
    shell: {
      exec: notWired,
      getExec: notWired,
      killExec: notWired,
      disposeExec: notWired,
    },
  };
}

function backend(id: string, sync?: SyncRPC): WorkspaceBackend {
  return {
    id,
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return { rpc: composite(sync ?? fakeSync()), close: async () => {} };
    },
  };
}

function failingBackend(id: string, reason: string): WorkspaceBackend {
  return {
    id,
    type: "fake",
    connect: () => Promise.reject(new Error(reason)),
  };
}

describe("Workspace observer — connection", () => {
  it("opens one workspace.connect span per backend dial and tags the backend id", async () => {
    // Backends connect lazily on first use; ready(id) is the
    // documented way to pre-warm one. The span fires once per
    // dial, tagged with the backend id and type.
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("primary")],
      observer,
    });
    await ws.ready("primary");
    const connectSpans = observer.spans.filter((s) => s.name === "workspace.connect");
    expect(connectSpans).toHaveLength(1);
    expect(connectSpans[0].attributes["workspace.backend.id"]).toBe("primary");
    expect(connectSpans[0].attributes["workspace.backend.type"]).toBe("fake");
    expect(connectSpans[0].outcome).toBe("ok");
  });

  it("records a failed backend dial as a failed span", async () => {
    // Per-backend addressing means a failure surfaces against the
    // named id rather than walking a fallback chain. The span on
    // the failed dial carries the error message.
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [failingBackend("first", "no thanks"), backend("second")],
      observer,
    });
    await expect(ws.ready("first")).rejects.toThrow(/no thanks/);
    const failed = observer.spans.filter((s) => s.name === "workspace.connect");
    expect(failed).toHaveLength(1);
    expect(failed[0].attributes["workspace.backend.id"]).toBe("first");
    expect(failed[0].outcome).toBe("error");
    expect(failed[0].attributes["error.message"]).toBe("no thanks");
    // Dialing the second backend separately still works — a
    // failed dial on `first` doesn't taint `second`.
    await ws.ready("second");
    const all = observer.spans.filter((s) => s.name === "workspace.connect");
    expect(all).toHaveLength(2);
    expect(all[1].attributes["workspace.backend.id"]).toBe("second");
    expect(all[1].outcome).toBe("ok");
  });
});

describe("Workspace observer — sync", () => {
  it("emits workspace.sync.push with the entry count attribute", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const pushed = await ws.push();
    const pushSpan = findSpan(observer.spans, "workspace.sync.push");
    expect(pushSpan.outcome).toBe("ok");
    expect(pushSpan.attributes["workspace.sync.pushed"]).toBe(pushed);
  });

  it("emits workspace.sync.pull with applied and skipped counts", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    await ws.pull();
    const pullSpan = findSpan(observer.spans, "workspace.sync.pull");
    expect(pullSpan.attributes["workspace.sync.applied"]).toBe(0);
    expect(pullSpan.attributes["workspace.sync.skipped"]).toBe(0);
  });
});

describe("Workspace observer — filesystem stub", () => {
  it("emits one workspace.fs.<op> span per stub method call", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const fs = new WorkspaceFilesystemStub(ws);

    await fs.writeFile("/a.txt", "hello");
    await fs.readFile("/a.txt", "utf8");
    await fs.stat("/a.txt");
    await fs.readdir("/");
    await fs.mkdir("/sub");
    await fs.rm("/a.txt");

    const fsNames = observer.spans
      .filter((s) => s.name.startsWith("workspace.fs."))
      .map((s) => s.name);
    expect(fsNames).toEqual([
      "workspace.fs.writeFile",
      "workspace.fs.readFile",
      "workspace.fs.stat",
      "workspace.fs.readdir",
      "workspace.fs.mkdir",
      "workspace.fs.rm",
    ]);

    const readdirSpan = findSpan(observer.spans, "workspace.fs.readdir");
    expect(readdirSpan.attributes["workspace.fs.path"]).toBe("/");
    expect(typeof readdirSpan.attributes["workspace.fs.entries"]).toBe("number");
  });

  it("records errors thrown by filesystem operations on the span", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const fs = new WorkspaceFilesystemStub(ws);
    await expect(fs.readFile("/missing.txt")).rejects.toBeDefined();
    const span = findSpan(observer.spans, "workspace.fs.readFile");
    expect(span.outcome).toBe("error");
    expect(typeof span.attributes["error.message"]).toBe("string");
  });
});

describe("Workspace observer — shell stub", () => {
  it("wraps the exec bracket in a workspace.shell.exec span with the sync nested underneath", async () => {
    const observer = makeRecorder();

    // The stub kicks off exec on construction, so the shell RPC has to
    // resolve right away. A minimal envelope is enough — the test only
    // asserts on span shape, not on stdout content.
    const execed: string[] = [];
    const shellRpc: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec(input) {
        execed.push(input.command);
        return {
          id: "exec-1",
          events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
            start(c) {
              c.enqueue({ id: "exec-1", seq: 0, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      async getExec() {
        throw new Error("not used");
      },
      async killExec() {
        // no-op
      },
      async disposeExec() {
        // no-op
      },
    };

    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        {
          id: "shelled",
          async connect() {
            return { rpc: { sync: fakeSync(), shell: shellRpc }, close: async () => {} };
          },
        },
      ],
      observer,
    });
    await ws.ready();
    const shellStub = new WorkspaceShellStub(ws);

    using handle = await shellStub.exec("echo hi");
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(execed).toEqual(["echo hi"]);

    const execSpan = findSpan(observer.spans, "workspace.shell.exec");
    expect(execSpan.outcome).toBe("ok");
    expect(execSpan.attributes["workspace.shell.exit_code"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.pushed"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.pulled"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.skipped"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.sync.status"]).toBe("complete");
    expect(execSpan.attributes["workspace.shell.sync.error"]).toBeUndefined();

    // Nesting: the bracket runs push → spawn → pull inside the exec
    // span's callback, so all three appear as children on the recorder.
    const childNames = execSpan.children.map((c) => c.name);
    expect(childNames).toContain("workspace.sync.push");
    expect(childNames).toContain("workspace.shell.exec.spawn");
    expect(childNames).toContain("workspace.sync.pull");
  });

  it("closes the exec span when the caller only kills the command", async () => {
    // kill() is a terminal path for callers that never read the
    // output: the signal goes out, the child exits, and nothing else
    // touches the handle. The span has to close on that path, and the
    // handle stays consumable so a caller can still collect the
    // output of the killed run.
    const observer = makeRecorder();
    let events!: ReadableStreamDefaultController<import("@cloudflare/computer-rpc").ExecEvent>;
    const shellRpc: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        return {
          id: "exec-killed",
          events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
            start(c) {
              events = c;
            },
          }),
        };
      },
      async getExec() {
        throw new Error("not used");
      },
      async killExec() {
        events.enqueue({ id: "exec-killed", seq: 0, name: "exit", value: 137 });
        events.close();
      },
      async disposeExec() {},
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        {
          id: "shelled",
          async connect() {
            return { rpc: { sync: fakeSync(), shell: shellRpc }, close: async () => {} };
          },
        },
      ],
      observer,
    });
    await ws.ready();
    using handle = await new WorkspaceShellStub(ws).exec("sleep 100");
    await handle.kill("SIGKILL");

    const execSpan = findSpan(observer.spans, "workspace.shell.exec");
    expect(execSpan.attributes["workspace.shell.sync.status"]).toBe("complete");
    expect(execSpan.attributes["workspace.shell.exit_code"]).toBe(-1);

    // The signal doesn't claim the handle: the output of the killed
    // run is still there for the asking.
    await expect(handle.result()).resolves.toMatchObject({ exitCode: 137 });
  });

  it("leaves the span to a stream() the kill interrupts", async () => {
    // Killing a command someone is streaming is not a terminal path
    // for the span: the reader sees the exit event the signal
    // produced, so it reports the real exit code and kill() keeps out
    // of the way.
    const observer = makeRecorder();
    let events!: ReadableStreamDefaultController<import("@cloudflare/computer-rpc").ExecEvent>;
    const shellRpc: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        return {
          id: "exec-streamed",
          events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
            start(c) {
              events = c;
            },
          }),
        };
      },
      async getExec() {
        throw new Error("not used");
      },
      async killExec() {
        events.enqueue({ id: "exec-streamed", seq: 0, name: "exit", value: 137 });
        events.close();
      },
      async disposeExec() {},
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        {
          id: "shelled",
          async connect() {
            return { rpc: { sync: fakeSync(), shell: shellRpc }, close: async () => {} };
          },
        },
      ],
      observer,
    });
    await ws.ready();
    using handle = await new WorkspaceShellStub(ws).exec("sleep 100");
    const reader = handle.stream().getReader();
    const first = reader.read();

    await handle.kill("SIGKILL");
    await first;
    while (!(await reader.read()).done) {
      // drain to close
    }
    reader.releaseLock();
    // The span closes once the reader reports the stream done; unlike
    // result(), nothing hands the caller a promise to await for it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const execSpan = findSpan(observer.spans, "workspace.shell.exec");
    expect(execSpan.attributes["workspace.shell.exit_code"]).toBe(137);
  });

  it("reports pending sync on the exec span without exposing secrets", async () => {
    const observer = makeRecorder();
    const secret = "observer-secret";
    const sync = fakeSync();
    sync.fetchChanges = async () => {
      throw new Error(`WebSocket closed token=${secret}`);
    };
    const shellRpc: import("@cloudflare/computer-rpc").ShellRPC = {
      async exec() {
        return {
          id: "exec-pending",
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: "exec-pending", seq: 0, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      async getExec() {
        throw new Error("not used");
      },
      async killExec() {},
      async disposeExec() {},
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        {
          id: "shelled",
          async connect() {
            return { rpc: { sync, shell: shellRpc }, close: async () => {} };
          },
        },
      ],
      observer,
    });
    await ws.ready();
    using handle = await new WorkspaceShellStub(ws).exec("noop");
    const result = await handle.result();
    expect(result.sync.status).toBe("pending");

    const execSpan = findSpan(observer.spans, "workspace.shell.exec");
    expect(execSpan.attributes["workspace.shell.sync.status"]).toBe("pending");
    expect(execSpan.attributes["workspace.shell.sync.error"]).toBe(
      "WebSocket closed token=[REDACTED]",
    );
    expect(JSON.stringify(execSpan.attributes)).not.toContain(secret);
  });
});

function findSpan(spans: readonly RecordedSpan[], name: string): RecordedSpan {
  const match = spans.find((s) => s.name === name);
  if (!match) throw new Error(`expected a recorded span named ${name}`);
  return match;
}
