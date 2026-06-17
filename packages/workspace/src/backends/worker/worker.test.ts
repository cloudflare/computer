// Tests for WorkerBackend.
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
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { Workspace } from "../../workspace.js";
import { WorkerBackend } from "./worker.js";

type WireEvent =
  | { id: string; seq: number; name: "stdout"; value: string }
  | { id: string; seq: number; name: "stderr"; value: string }
  | { id: string; seq: number; name: "exit"; value: number };

interface FakeShellFetcher {
  exec(input: { command: string; cwd?: string; id?: string; timeoutMs?: number }): Promise<{
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
  exec: (input: { command: string; cwd?: string; id?: string; timeoutMs?: number }) => {
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
  // wiring a real sync peer. WorkerBackend itself declares
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

describe("WorkerBackend", () => {
  it("returns a BackendHandle with sync: 'none'", async () => {
    const fetcher = fakeFetcher(() => {
      throw new Error("exec not called in this test");
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage() as never,
      backends: [noopFsBackend()],
    });
    await ws.ready();
    const backend = new WorkerBackend({ fetcher: () => fetcher });
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
    const backend = new WorkerBackend({ fetcher: () => fetcher });
    const handle = await backend.connect();

    const envelope = await handle.rpc.shell.exec({ command: "echo hello" });
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
      { id: "run-1", seq: 2, name: "exit", value: 0 },
    ]);
    expect(envelope.id).toBe("run-1");
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
    const backend = new WorkerBackend({ fetcher: () => fetcher });
    const handle = await backend.connect();
    await handle.rpc.shell.exec({ command: "x", cwd: "/workspace/src", id: "fixed" });
    expect(observed?.cwd).toBe("/workspace/src");
    expect(observed?.id).toBe("fixed");
  });

  it("plumbs through Workspace.shell.exec end-to-end", async () => {
    // Construct WorkerBackend as the sole backend of a Workspace
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
      backends: [new WorkerBackend({ fetcher: () => fetcher })],
    });
    await ws.ready();
    const handle = await ws.shell.exec("echo world", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("world\n");
    expect(result.stderr).toBe("");
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.skipped).toEqual([]);
  });

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

    const backend = new WorkerBackend({
      loader,
      workspace: { binding: "WorkspaceHost", id: "abc" },
      ctx,
    });
    await backend.connect();

    expect(observedDate).toBe("2026-06-17");
    expect(observedFlags).toEqual(["nodejs_compat"]);
  });

  it("resolves an async fetcher factory once per connect()", async () => {
    // A factory that fetches code from KV before minting the
    // Worker Loader stub will be async. The backend awaits it
    // exactly once per connect(); subsequent shell.exec calls
    // reuse the resolved Fetcher.
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
    const backend = new WorkerBackend({
      fetcher: async () => {
        factoryCalls += 1;
        return fetcher;
      },
    });
    const handle = await backend.connect();
    await handle.rpc.shell.exec({ command: "true" });
    await handle.rpc.shell.exec({ command: "true" });
    expect(factoryCalls).toBe(1);
  });
});
