// Direct tests for the WorkspaceStub class.
//
// The stub wraps a host-side Workspace as a capnweb RpcTarget so it
// can be returned across a Workers-RPC boundary. The class exposes
// fs and shell sub-stubs via accessor properties (a constraint of
// Workers RPC — plain readonly fields land as private isolate state
// and would report "method not implemented").
//
// These tests construct the stub directly against an in-process
// Workspace; we don't go through workerd. The point is to pin the
// class's own contract: accessor shape, eager spawn, readFile
// overload routing, stat ENOENT propagation, close() idempotency.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { enableStubTracking, stubSnapshot } from "@cloudflare/workspace-rpc/debug";
import { beforeAll, describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { decodeExecEvents } from "./exec-wire.js";
import type { ExecHandle, ExecResult } from "./shell.js";
import {
  WorkspaceAssetsStub,
  WorkspaceExecHandleStub,
  WorkspaceFilesystemStub,
  WorkspaceGitStub,
  WorkspaceShellStub,
} from "./stub.js";
import { Workspace } from "./workspace.js";

function composite(
  sync: import("@cloudflare/workspace-rpc").SyncRPC,
  shell?: Partial<import("@cloudflare/workspace-rpc").ShellRPC>,
): import("@cloudflare/workspace-rpc").WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("not wired in this test"));
  return {
    sync,
    shell: {
      exec: notWired,
      getExec: notWired,
      killExec: notWired,
      disposeExec: notWired,
      ...shell,
    },
  };
}

function fakeSync(): import("@cloudflare/workspace-rpc").SyncRPC {
  return {
    async push() {
      return { rev: 0, appliedPushCursor: { rev: 0, path: null } };
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
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
    },
    async hasObjects() {
      return [];
    },
    fetchObjects() {
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
    pushObjects() {
      return Promise.resolve();
    },
  };
}

function backend(
  rpc?: Partial<import("@cloudflare/workspace-rpc").WorkspaceRPC>,
): WorkspaceBackend {
  return {
    id: "test",
    async connect(): Promise<BackendHandle> {
      const sync = rpc?.sync ?? fakeSync();
      const shell = rpc?.shell as Partial<import("@cloudflare/workspace-rpc").ShellRPC> | undefined;
      return { rpc: composite(sync, shell), close: async () => {} };
    },
  };
}

function snapshotOf(names: string[]): Record<string, number> {
  const snap = stubSnapshot();
  const out: Record<string, number> = {};
  for (const name of names) out[name] = snap[name] ?? 0;
  return out;
}

async function withStub<T>(
  fn: (ws: Workspace) => T | Promise<T>,
  options?: Pick<ConstructorParameters<typeof Workspace>[0], "assets"> & {
    backend?: WorkspaceBackend;
  },
): Promise<T> {
  const ws = new Workspace({
    storage: new SQLiteTestStorage(),
    backends: [options?.backend ?? backend()],
    assets: options?.assets,
  });
  try {
    await ws.ready();
    return await fn(ws);
  } finally {
    await ws.close();
  }
}

describe("WorkspaceStub", () => {
  it("exposes fs, shell, git, and optional assets as accessor properties (RPC visibility)", async () => {
    // Plain readonly fields would land as private isolate state on
    // the RPC stub and report "method not implemented". The class
    // uses getters; pin that here by checking the descriptor.
    await withStub(async (ws) => {
      const stub = ws.stub();
      const fsDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "fs");
      const shellDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "shell");
      const gitDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "git");
      const assetsDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stub), "assets");
      expect(fsDesc?.get).toBeTypeOf("function");
      expect(shellDesc?.get).toBeTypeOf("function");
      expect(gitDesc?.get).toBeTypeOf("function");
      expect(assetsDesc?.get).toBeTypeOf("function");
      expect(stub.fs).toBeInstanceOf(WorkspaceFilesystemStub);
      expect(stub.shell).toBeInstanceOf(WorkspaceShellStub);
      expect(stub.git).toBeInstanceOf(WorkspaceGitStub);
      expect(stub.assets).toBeUndefined();
    });
  });

  it("assets.publish forwards to the configured assets client", async () => {
    const calls: Array<{ path: string; expiresAfter: number }> = [];
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        expect(stub.assets).toBeInstanceOf(WorkspaceAssetsStub);
        const url = await stub.assets?.publish("/workspace/out.png", { expiresAfter: 30_000 });
        expect(url).toBe("https://example.com/out.png");
        expect(calls).toEqual([{ path: "/workspace/out.png", expiresAfter: 30_000 }]);
      },
      {
        assets: {
          async share(path, options) {
            calls.push({ path, expiresAfter: options.expiresAfter });
            return "https://example.com/out.png";
          },
        },
      },
    );
  });

  it("git.cli forwards through to the underlying Workspace", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      const res = await stub.git.cli({ argv: ["help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("usage: git");
    });
  });

  it("fs.writeFile + fs.readFile round-trip utf8", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await stub.fs.writeFile("/hello.txt", "hello stub");
      expect(await stub.fs.readFile("/hello.txt", "utf8")).toBe("hello stub");
    });
  });

  it("fs.readFile returns a ReadableStream by default", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await stub.fs.writeFile("/bin", new Uint8Array([7, 8, 9]));
      const stream = await stub.fs.readFile("/bin");
      expect(stream).toBeInstanceOf(ReadableStream);
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(Array.from(buf)).toEqual([7, 8, 9]);
    });
  });

  it("fs.stat propagates ENOENT for missing paths", async () => {
    await withStub(async (ws) => {
      const stub = ws.stub();
      await expect(stub.fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("shell.exec auto-reconnects after the backend signals closed", async () => {
    // When the underlying transport drops mid-session, the
    // Workspace clears its cached BackendHandle for that backend
    // id. The next stub.shell.exec call must dial a fresh handle
    // through the lazy-connect path rather than reuse the dead
    // one. Pin the heal so a transport drop is invisible to the
    // caller.
    let signalClosed!: () => void;
    let connectCount = 0;
    let execCalls = 0;
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        execCalls += 1;
        return {
          id: `e-${execCalls}`,
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: `e-${execCalls}`, seq: 1, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    const reconnectBackend: WorkspaceBackend = {
      id: "reconnect",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        connectCount += 1;
        // First connect arms a controllable `closed` promise; later
        // connects don't need one for this test.
        const closed =
          connectCount === 1
            ? new Promise<void>((resolve) => {
                signalClosed = resolve;
              })
            : undefined;
        return {
          rpc: composite(fakeSync(), shellRpc),
          closed,
          close: async () => {},
        };
      },
    };
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [reconnectBackend],
    });
    try {
      // Backends connect lazily on first use; ready(id) is the
      // documented way to pre-warm one.
      await ws.ready("reconnect");
      expect(connectCount).toBe(1);
      const stub = ws.stub();

      // Simulate a mid-session transport drop. The Workspace's
      // `closed` listener drops the cached handle for this id
      // in a microtask, so yield once before exercising the stub.
      signalClosed();
      await new Promise((r) => setTimeout(r, 0));

      // The next stub.shell.exec call enters the lazy connect
      // path against the now-empty handle cache and reconnects.
      const handle = await stub.shell.exec("noop");
      const res = await handle.result();
      expect(res.exitCode).toBe(0);
      expect(connectCount).toBe(2);
      expect(execCalls).toBe(1);
    } finally {
      await ws.close();
    }
  });

  describe("disposal cascade", () => {
    // The `fs` and `shell` sub-stubs are owned by the parent stub.
    // Workers RPC exposes them as getters, so a caller can't reach
    // them as independent stubs; their lifetime is bounded by the
    // parent's. WorkspaceStub[Symbol.dispose] is what enforces that
    // bound — without the cascade, every getWorkspace() leaks two
    // sub-stubs on the peer side.
    //
    // The WorkerBackend reaches the fs half via `stub().fs` and
    // depends on this cascade for its own disposal contract; pin
    // it here so a future refactor that drops the cascade fails
    // loudly.
    beforeAll(() => {
      enableStubTracking();
    });

    it("disposing the parent stub releases fs, shell, and git sub-stubs", async () => {
      await withStub(async (ws) => {
        const names = [
          "WorkspaceStub",
          "WorkspaceFilesystemStub",
          "WorkspaceShellStub",
          "WorkspaceGitStub",
        ];
        const before = snapshotOf(names);
        {
          using stub = ws.stub();
          // Touch every half so any lazy construction lands.
          expect(stub.fs).toBeInstanceOf(WorkspaceFilesystemStub);
          expect(stub.shell).toBeInstanceOf(WorkspaceShellStub);
          expect(stub.git).toBeInstanceOf(WorkspaceGitStub);
          const live = snapshotOf(names);
          expect(live.WorkspaceStub).toBe(before.WorkspaceStub + 1);
          expect(live.WorkspaceFilesystemStub).toBe(before.WorkspaceFilesystemStub + 1);
          expect(live.WorkspaceShellStub).toBe(before.WorkspaceShellStub + 1);
          expect(live.WorkspaceGitStub).toBe(before.WorkspaceGitStub + 1);
        }
        // Out of scope — `using` ran Symbol.dispose on the parent,
        // which cascades to fs, shell, and git.
        const after = snapshotOf(names);
        expect(after).toEqual(before);
      });
    });

    it("stub().fs survives long enough for the backend to hand it off", async () => {
      // The WorkerBackend pattern is:
      //   using stub = workspace.stub();
      //   await fetcher.exec(input, stub.fs);
      // The fs reference must remain a live RpcTarget for the
      // duration of the call. Verify that reading `.fs` doesn't
      // dispose the parent and that the same getter returns the
      // same instance on repeat access.
      await withStub(async (ws) => {
        using stub = ws.stub();
        const first = stub.fs;
        const second = stub.fs;
        expect(first).toBe(second);
        const live = snapshotOf(["WorkspaceFilesystemStub"]);
        expect(live.WorkspaceFilesystemStub).toBeGreaterThanOrEqual(1);
      });
    });
  });

  it("shell result carries the structured sync outcome across Workers RPC", async () => {
    const result = {
      exitCode: 0,
      stdout: "done",
      stderr: "",
      pushed: 1,
      pulled: 0,
      skipped: [],
      sync: {
        status: "pending" as const,
        applied: 0,
        skipped: [],
        error: "WebSocket closed before pull completed",
      },
    } satisfies ExecResult<"utf8">;
    const hostHandle = { result: async () => result } as ExecHandle<"utf8">;
    using handle = new WorkspaceExecHandleStub<"utf8">(
      Promise.resolve(hostHandle),
      {
        promise: Promise.resolve({
          exitCode: 0,
          pushed: 0,
          pulled: 0,
          skippedCount: 0,
          sync: { status: "complete", applied: 0, skipped: [] },
        }),
        resolve() {},
      },
      Promise.resolve(),
    );
    await expect(handle.result()).resolves.toMatchObject({
      exitCode: 0,
      sync: {
        status: "pending",
        applied: 0,
        skipped: [],
        error: "WebSocket closed before pull completed",
      },
    });
  });

  it("shell.exec returns an eagerly-spawned handle", async () => {
    // The stub's exec() kicks off the underlying workspace.shell.exec
    // before returning, so the caller's first round trip already has
    // the spawn in flight. We can't directly observe "eager" without
    // a clock, but we can pin that the returned handle is the right
    // shape and that result() resolves.
    let execCalls = 0;
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        execCalls += 1;
        return {
          id: `e-${execCalls}`,
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: `e-${execCalls}`, seq: 1, name: "stdout", value: new Uint8Array() });
              c.enqueue({ id: `e-${execCalls}`, seq: 2, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        const handle = await stub.shell.exec("noop");
        expect(handle).toBeInstanceOf(WorkspaceExecHandleStub);
        // exec ran by the time result() resolves. The stub kicks off
        // the underlying exec eagerly (via promise chaining) so the
        // caller doesn't pay an extra round trip before result().
        const res = await handle.result();
        expect(execCalls).toBe(1);
        expect(res.exitCode).toBe(0);
      },
      { backend: backend({ shell: shellRpc }) },
    );
  });

  it("shell.exec handle.stream() frames events as JSONL that decode back", async () => {
    // The handle's stream() projects the event stream as JSONL bytes
    // for the wire. Decoding it back yields the original events,
    // including a binary stdout chunk carried base64.
    const payload = new Uint8Array([0x00, 0xff, 0x41]);
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        return {
          id: "e-1",
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: "e-1", seq: 1, name: "stdout", value: payload });
              c.enqueue({ id: "e-1", seq: 2, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        const handle = await stub.shell.exec("noop");
        const events: Array<{ name: string; value: unknown }> = [];
        const decoded = decodeExecEvents(handle.stream());
        const reader = decoded.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push({ name: value.name, value: value.value });
        }
        reader.releaseLock();
        expect(events).toHaveLength(2);
        expect(events[0].name).toBe("stdout");
        expect(Array.from(events[0].value as Uint8Array)).toEqual(Array.from(payload));
        expect(events[1]).toEqual({ name: "exit", value: 0 });
      },
      { backend: backend({ shell: shellRpc }) },
    );
  });

  it("shell.exec handle.stream() waits for the wire consumer to pull", async () => {
    let pulls = 0;
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        return {
          id: "e-1",
          events: new ReadableStream({
            pull(c) {
              pulls += 1;
              if (pulls < 10) {
                c.enqueue({
                  id: "e-1",
                  seq: pulls,
                  name: "stdout",
                  value: new Uint8Array([pulls]),
                });
                return;
              }
              c.enqueue({ id: "e-1", seq: 10, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        const handle = await stub.shell.exec("noop");
        const wire = handle.stream();
        await Promise.resolve();
        expect(pulls).toBe(0);

        const reader = wire.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain('"name":"stdout"');
        expect(pulls).toBeLessThan(10);
        await reader.cancel();
        reader.releaseLock();
      },
      { backend: backend({ shell: shellRpc }) },
    );
  });

  it("shell.exec handle rejects result() after stream() has claimed it", async () => {
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec() {
        return {
          id: "e-1",
          events: new ReadableStream({
            start(c) {
              c.enqueue({ id: "e-1", seq: 1, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      getExec: () => Promise.reject(new Error("not used")),
      killExec: () => Promise.reject(new Error("not used")),
      disposeExec: () => Promise.reject(new Error("not used")),
    };
    await withStub(
      async (ws) => {
        const stub = ws.stub();
        const handle = await stub.shell.exec("noop");
        handle.stream();
        await expect(handle.result()).rejects.toThrow(/single-shot/);
      },
      { backend: backend({ shell: shellRpc }) },
    );
  });
});
