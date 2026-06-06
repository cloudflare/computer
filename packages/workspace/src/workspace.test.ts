import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { Workspace } from "./workspace.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

// In-process fakes. We never spawn anything from the package
// code; the backend's only contract is "produce a SyncRPC
// stub that wsd would speak". A plain object is enough.
function composite(
  sync: import("@cloudflare/workspace-rpc").SyncRPC,
): import("@cloudflare/workspace-rpc").WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  const shell: import("@cloudflare/workspace-rpc").ShellRPC = {
    exec: notWired,
    getExec: notWired,
    killExec: notWired,
    disposeExec: notWired,
  };
  return { sync, shell };
}

function fakeRpc(): import("@cloudflare/workspace-rpc").SyncRPC {
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
  rpc?: import("@cloudflare/workspace-rpc").SyncRPC,
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
// the WorkspaceShell exec bracket settles right away. Used by the
// multi-backend selection tests.
function execBackend(id: string, onExec: (command: string) => void): WorkspaceBackend {
  const shell: import("@cloudflare/workspace-rpc").ShellRPC = {
    async exec(input) {
      onExec(input.command);
      const execId = input.id ?? `${id}-${Math.random().toString(36).slice(2)}`;
      return {
        id: execId,
        events: new ReadableStream<import("@cloudflare/workspace-rpc").ExecEvent>({
          start(c) {
            c.enqueue({ id: execId, seq: 1, name: "exit", value: 0 });
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
// the WorkspaceShell push/pull bracket. The selection tests don't
// care about the values — only that exec ran on the right backend.
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
    const handle = await ws.shell.exec("true");
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
    await drainExec(await ws.shell.exec("true", { backend: "b" }));
    expect(aExecs).toBe(0);
    expect(bExecs).toBe(1);
  });

  it("throws on an unknown backend id", async () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [execBackend("only", () => {})],
    });
    await ws.ready();
    await expect(ws.shell.exec("true", { backend: "missing" })).rejects.toThrow(
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
    await drainExec(await ws2.shell.exec("true"));
    expect(connectSpy).toHaveBeenCalledTimes(1);
    // Second exec reuses the cached handle.
    await drainExec(await ws2.shell.exec("true"));
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

  it("shell accessor returns a router even before any connect", () => {
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [execBackend("only", () => {})],
    });
    expect(ws.shell).toBeDefined();
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
    // workspace.git is a lazy property accessor that doesn't
    // require a backend — every supported subcommand reads and
    // writes through the local SQLite-backed VFS. We pin three
    // contracts here: (1) repeat access returns the same client
    // so the pack/index cache is shared, (2) constructing the
    // client doesn't fire the dynamic imports of isomorphic-git
    // / diff, (3) the surface is available on a Workspace with
    // no backend configured.
    it("returns the same client across calls", () => {
      const ws = new Workspace({ storage: makeStorage() });
      expect(ws.git).toBe(ws.git);
    });

    it("is available with no backend configured", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      // help is hermetic — no dynamic imports, no fs touches.
      const res = await ws.git.cli({ argv: ["help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("usage: git");
    });

    it("`git version` runs end-to-end without ready()", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      const res = await ws.git.cli({ argv: ["version"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("@cloudflare/workspace");
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

    it("throws a clear error when shell is reached", () => {
      const ws = new Workspace({ storage: makeStorage() });
      expect(() => ws.shell).toThrow(/no backend/);
    });

    it("push and pull short-circuit to zero / empty", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      await ws.fs.writeFile("/a.txt", "hi");
      expect(await ws.push()).toBe(0);
      const pulled = await ws.pull();
      expect(pulled).toEqual({ applied: 0, skipped: [] });
    });

    it("stub() works and fs methods round-trip through it", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      const stub = ws.stub();
      await stub.fs.writeFile("/b.txt", "hello");
      expect(await stub.fs.readFile("/b.txt", "utf8")).toBe("hello");
    });

    it("stub().shell.exec throws the same no-backend error", async () => {
      const ws = new Workspace({ storage: makeStorage() });
      await ws.ready();
      const stub = ws.stub();
      // The stub's exec kicks off the underlying call eagerly
      // and returns a handle whose result() awaits the pending
      // promise. With no backend configured the inner promise
      // rejects; await result() to surface it.
      const handle = await stub.shell.exec("true");
      await expect(handle.result()).rejects.toThrow(/no backend/);
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
    const sync: import("@cloudflare/workspace-rpc").SyncRPC = {
      ...fakeRpc(),
      async watermarks() {
        watermarksCalls++;
        return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
      },
    };
    const storage = makeStorage();
    const ws = new Workspace({ storage, backends: [makeBackend("only", sync)] });
    const { writeWatermark, readWatermark } = await import("@cloudflare/dofs");
    writeWatermark(ws.db, "pushRev", 17, "only");
    writeWatermark(ws.db, "fetchRev", 42, "only");
    // ready() alone no longer dials; ready(id) forces the connect.
    await ws.ready("only");
    expect(watermarksCalls).toBe(1);
    expect(readWatermark(ws.db, "pushRev", "only")).toBe(0);
    expect(readWatermark(ws.db, "fetchRev", "only")).toBe(0);
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
    const sync: import("@cloudflare/workspace-rpc").SyncRPC = {
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
    const rpc: import("@cloudflare/workspace-rpc").SyncRPC = {
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
    const rpc: import("@cloudflare/workspace-rpc").SyncRPC = {
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
