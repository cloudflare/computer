import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { Workspace } from "../../workspace.js";
import { WorkerJavaScriptBackend } from "./worker-javascript.js";

function throwingLoader(message: string) {
  return {
    load() {
      throw new Error(message);
    },
  };
}

// Drive a successful result the way the real runner does: validate
// through the bridge, frame result + exit, hand the readable to
// attachOutput, and stay "in flight" until the host finishes draining.
async function evaluateResult(
  host: {
    assertResult(value: unknown): Promise<void>;
    attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
  },
  value: unknown,
): Promise<void> {
  const frames: string[] = [];
  try {
    await host.assertResult(value);
    frames.push(JSON.stringify({ name: "exit", code: 0, result: value }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    frames.push(JSON.stringify({ name: "stderr", b64: btoa(`${message}\n`) }));
    frames.push(JSON.stringify({ name: "exit", code: 1 }));
  }
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n`));
      controller.close();
    },
  });
  await host.attachOutput(readable);
}

describe("WorkerJavaScriptBackend", () => {
  it("blocks ambient egress by default", async () => {
    const load = vi.fn(() => ({
      getEntrypoint() {
        return {
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, null),
        };
      },
    }));
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load } })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });

    await (await workspace.runtime.exec("export default null")).result();

    expect(load.mock.calls[0]?.[0]).toMatchObject({ globalOutbound: null });
  });

  it("omits globalOutbound for direct egress", async () => {
    const load = vi.fn(() => ({
      getEntrypoint() {
        return {
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, null),
        };
      },
    }));
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load },
          egress: { mode: "direct" },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });

    await (await workspace.runtime.exec("export default null")).result();

    expect(load.mock.calls[0]?.[0]).not.toHaveProperty("globalOutbound");
  });

  it("routes ambient egress through an HTTP gateway", async () => {
    const gateway = { fetch: vi.fn() } as unknown as Fetcher;
    const load = vi.fn(() => ({
      getEntrypoint() {
        return {
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, null),
        };
      },
    }));
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load },
          egress: { mode: "http-gateway", gateway },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });

    await (await workspace.runtime.exec("export default null")).result();

    expect(load.mock.calls[0]?.[0]).toMatchObject({ globalOutbound: gateway });
  });

  it("rejects globalOutbound together with egress", () => {
    expect(
      () =>
        new WorkerJavaScriptBackend({
          loader: throwingLoader("unused"),
          globalOutbound: null,
          egress: { mode: "none" },
        }),
    ).toThrow(/globalOutbound.*egress/);
  });

  it("validates timeout configuration", () => {
    expect(
      () =>
        new WorkerJavaScriptBackend({
          loader: throwingLoader("unused"),
          maxTimeoutMs: Number.NaN,
        }),
    ).toThrow(/positive finite/);
    expect(
      () =>
        new WorkerJavaScriptBackend({
          loader: throwingLoader("unused"),
          defaultTimeoutMs: -1,
        }),
    ).toThrow(/positive finite/);
  });

  it("includes the configured capability byte limit in generated errors", async () => {
    const load = vi.fn(() => ({
      getEntrypoint() {
        return {
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, null),
        };
      },
    }));
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load },
          maxCapabilityBytes: 256,
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });

    await (await workspace.runtime.exec("export default null")).result();

    const capabilities = load.mock.calls[0]?.[0].modules["workspace-capabilities.js"];
    expect(capabilities).toEqual(expect.any(String));
    expect(capabilities).toContain("exceeds 256 bytes");
    expect(capabilities).not.toContain("maxCapabilityBytes");
  });

  it("disposes Loader resources when evaluate throws synchronously", async () => {
    let entrypointDisposals = 0;
    let workerDisposals = 0;
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: {
            load() {
              return {
                getEntrypoint() {
                  return {
                    evaluate() {
                      throw new Error("evaluate failed");
                    },
                    [Symbol.dispose]() {
                      entrypointDisposals += 1;
                    },
                  };
                },
                [Symbol.dispose]() {
                  workerDisposals += 1;
                },
              };
            },
          },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const execution = await workspace.runtime.exec("export default 1", { encoding: "utf8" });
    await expect(execution.result()).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("evaluate failed"),
    });
    expect(entrypointDisposals).toBe(1);
    expect(workerDisposals).toBe(1);
  });

  it("migrates the legacy execution journal schema", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    db.run(`CREATE TABLE workspace_runtime_executions (
      backend TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (backend, id)
    )`);
    db.run(
      `INSERT INTO workspace_runtime_executions (backend, id, status)
       VALUES ('isolate-javascript', 'legacy', 'completed')`,
    );
    const fs = new WorkspaceFilesystem(db);
    const backend = new WorkerJavaScriptBackend({ loader: throwingLoader("unused") });
    await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const columns = db.all<{ name: string }>("PRAGMA table_info(workspace_runtime_executions)");
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["created_at", "finished_at"]),
    );
    expect(
      db.scalar<number>("SELECT finished_at FROM workspace_runtime_executions WHERE id = 'legacy'"),
    ).toBeTypeOf("number");
  });

  it("enforces finite input and result byte ceilings", async () => {
    const load = vi.fn(() => ({
      getEntrypoint() {
        return {
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, "result-too-large"),
        };
      },
    }));
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load },
          maxInputBytes: 8,
          maxResultBytes: 8,
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec("export default 1", { input: "input-too-large" }),
    ).rejects.toThrow("input exceeds 8 bytes");
    expect(load).not.toHaveBeenCalled();

    const execution = await workspace.runtime.exec("export default 1", { encoding: "utf8" });
    await expect(execution.result()).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("result exceeds 8 bytes"),
    });
  });

  it("rejects an execution whose module graph finishes after the handle closes", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    await fs.writeFile("/workspace/task.js", "export default 1");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const readFile = fs.readFile.bind(fs);
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      await blocked;
      return readFile(...args);
    }) as typeof fs.readFile;
    const backend = new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = handle.exec({
      source: `import task from "./task.js"; export default task;`,
      cwd: "/workspace",
    });
    await Promise.resolve();
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await expect(execution).rejects.toMatchObject({ code: "ECLOSED" });
  });

  it("rejects stdin larger than the configured ceiling", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load }, maxStdinBytes: 8 })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec("export default 1", { stdin: "x".repeat(64) }),
    ).rejects.toThrow(/stdin exceeds 8 bytes/);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects env larger than the configured ceiling", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load }, maxEnvBytes: 8 })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec("export default 1", { env: { KEY: "x".repeat(64) } }),
    ).rejects.toThrow(/env exceeds 8 bytes/);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects non-string env values", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load } })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec("export default 1", {
        env: { KEY: 42 as unknown as string },
      }),
    ).rejects.toThrow(/env value for "KEY" must be a string/);
    expect(load).not.toHaveBeenCalled();
  });

  it("checks limits against the complete loader map including the runtime runner", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load }, maxSourceBytes: 128 })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const execution = await workspace.runtime.exec("export default 1", { encoding: "utf8" });
    await expect(execution.result()).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("loader graph exceeds 128 source bytes"),
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("records synchronous loader startup failure as a completed failed execution", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: throwingLoader("loader failed"),
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const handle = await workspace.runtime.exec("export default () => 1", {
      backend: "worker-javascript",
      id: "startup-failure",
      encoding: "utf8",
    });
    await expect(handle.result()).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      stderr: expect.stringContaining("loader failed"),
    });
    const replay = await workspace.runtime.getExec("startup-failure", {
      backend: "worker-javascript",
      encoding: "utf8",
    });
    await expect(replay.result()).resolves.toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("replays a coherent failure after backend recreation interrupts a run", async () => {
    const storage = new SQLiteTestStorage();
    const dispose = vi.fn();
    const loader = {
      load() {
        return {
          getEntrypoint() {
            return { evaluate: () => new Promise(() => undefined) };
          },
          [Symbol.dispose]: dispose,
        };
      },
    };
    const first = new Workspace({
      storage,
      backends: [new WorkerJavaScriptBackend({ loader })],
    });
    await first.fs.mkdir("/workspace", { recursive: true });
    await first.runtime.exec("export default async () => new Promise(() => {})", {
      backend: "worker-javascript",
      id: "interrupted",
    });

    const recreated = new Workspace({
      storage,
      backends: [new WorkerJavaScriptBackend({ loader })],
    });
    const replay = await recreated.runtime.getExec("interrupted", {
      backend: "worker-javascript",
      encoding: "utf8",
    });
    await expect(replay.result()).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      stderr: expect.stringContaining("runtime restarted"),
    });
    await first.close();
  });

  it("reserves an explicit execution id while module construction is in flight", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: {
            load() {
              return {
                getEntrypoint() {
                  return { evaluate: () => new Promise(() => undefined) };
                },
              };
            },
          },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const [first, second] = await Promise.allSettled([
      workspace.runtime.exec("export default async () => new Promise(() => {})", {
        id: "shared-id",
      }),
      workspace.runtime.exec("export default 2", { id: "shared-id" }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = first.status === "rejected" ? first.reason : second.reason;
    expect(rejected).toMatchObject({ code: "EEXEC_BUSY" });
    await workspace.close();
  });

  it("waits for accepted host calls before reporting successful completion", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = fs.writeFile.bind(fs);
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      await writeReleased;
      return originalWrite(...args);
    }) as typeof fs.writeFile;
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                evaluate(
                  _input: unknown,
                  host: {
                    call(name: string, args: string): Promise<string>;
                    assertResult(value: unknown): Promise<void>;
                    attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
                  },
                ) {
                  void host.call("fs.writeFile", ["/workspace/output.txt", "done"]);
                  return evaluateResult(host, 1);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "successful-host-call", source: "export default 1" });
    let settled = false;
    const terminal = (async () => {
      const events = [];
      for await (const event of execution.events) events.push(event);
      settled = true;
      return events;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseWrite();
    const events = await terminal;
    expect(await fs.readFile("/workspace/output.txt", "utf8")).toBe("done");
    expect(events.at(-1)).toMatchObject({ name: "exit", code: 0 });
  });

  it("streams stdout before user code returns", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let releaseExit!: () => void;
    const exitReleased = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const encoder = new TextEncoder();
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(
                  _input: unknown,
                  host: { attachOutput(readable: ReadableStream<Uint8Array>): Promise<void> },
                ) {
                  const readable = new ReadableStream<Uint8Array>({
                    async start(controller) {
                      controller.enqueue(
                        encoder.encode(
                          `${JSON.stringify({ name: "stdout", b64: btoa("live\n") })}\n`,
                        ),
                      );
                      await exitReleased;
                      controller.enqueue(
                        encoder.encode(`${JSON.stringify({ name: "exit", code: 0 })}\n`),
                      );
                      controller.close();
                    },
                  });
                  await host.attachOutput(readable);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "live-stream", source: "export default 1" });
    const reader = execution.events.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ name: "stdout" });
    expect(new TextDecoder().decode((first.value as { value: Uint8Array }).value)).toBe("live\n");
    releaseExit();
    reader.releaseLock();
    await handle.close();
  });

  it("stops draining and settles with the kill exit when cancelled mid-stream", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(
                  _input: unknown,
                  host: { attachOutput(readable: ReadableStream<Uint8Array>): Promise<void> },
                ) {
                  const readable = new ReadableStream<Uint8Array>({
                    start(controller) {
                      streamController = controller;
                      controller.enqueue(
                        encoder.encode(
                          `${JSON.stringify({ name: "stdout", b64: btoa("live\n") })}\n`,
                        ),
                      );
                      // Stays open with no exit frame: the run is torn down
                      // by cancellation rather than finishing on its own.
                    },
                  });
                  await host.attachOutput(readable);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "kill-mid-stream", source: "export default 1" });
    const reader = execution.events.getReader();
    const first = await reader.read();
    expect(first.value).toMatchObject({ name: "stdout" });
    reader.releaseLock();
    await handle.killExec({ id: execution.id });
    // Cancellation disposes the Dynamic Worker, which errors the transferred
    // output stream. Mirror that so the live pump's pending read rejects
    // after the record has already settled.
    streamController.error(new Error("worker disposed"));
    const events = [];
    for await (const event of execution.events) events.push(event);
    const exitIndex = events.findIndex((event) => event.name === "exit");
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(events[exitIndex]).toMatchObject({ name: "exit", code: 130 });
    // The exit event is terminal: no stdout, stderr, or result follows it.
    expect(events.slice(exitIndex + 1)).toEqual([]);
    await handle.close();
  });

  it("settles as failed when the output stream closes without an exit frame", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    const encoder = new TextEncoder();
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(
                  _input: unknown,
                  host: { attachOutput(readable: ReadableStream<Uint8Array>): Promise<void> },
                ) {
                  // Emit stdout, then close the stream with no result or
                  // exit frame, mimicking a dropped terminal write.
                  const readable = new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        encoder.encode(
                          `${JSON.stringify({ name: "stdout", b64: btoa("partial\n") })}\n`,
                        ),
                      );
                      controller.close();
                    },
                  });
                  await host.attachOutput(readable);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "no-exit", source: "export default 1" });
    const events = [];
    for await (const event of execution.events) events.push(event);
    const exit = events.find((event) => event.name === "exit");
    expect(exit).toMatchObject({ name: "exit", code: 1 });
    expect(events.some((event) => event.name === "result")).toBe(false);
    await handle.close();
  });

  it("aborts cooperative host module calls at their deadline", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let aborted = false;
    const backend = new WorkerJavaScriptBackend({
      maxHostCallMs: 5,
      modules: {
        "ws:test": {
          run(_args, context) {
            return new Promise((_resolve, reject) => {
              context.signal.addEventListener("abort", () => {
                aborted = true;
                reject(context.signal.reason);
              });
            });
          },
        },
      },
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(
                  _input: unknown,
                  host: { call(name: string, args: unknown[]): Promise<unknown> },
                ) {
                  await host.call("host/ws:test.run", []);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "trusted-timeout", source: "export default 1" });
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ name: "exit", code: 1 });
  });

  it("waits for accepted host calls before reporting cancellation", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const originalWrite = fs.writeFile.bind(fs);
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      callStarted();
      await writeReleased;
      return originalWrite(...args);
    }) as typeof fs.writeFile;
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                evaluate(
                  _input: unknown,
                  host: { call(name: string, args: unknown[]): Promise<unknown> },
                ) {
                  void host.call("fs.writeFile", ["/workspace/output.txt", "done"]);
                  return new Promise(() => undefined);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "cancel-host-call", source: "export default 1" });
    await started;
    let killed = false;
    const kill = handle.killExec({ id: execution.id }).then(() => {
      killed = true;
    });
    let secondKilled = false;
    const secondKill = handle.killExec({ id: execution.id }).then(() => {
      secondKilled = true;
    });
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(killed).toBe(false);
    expect(secondKilled).toBe(false);
    expect(closed).toBe(false);
    releaseWrite();
    await Promise.all([kill, secondKill, closing]);
    expect(await fs.readFile("/workspace/output.txt", "utf8")).toBe("done");
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ name: "exit", code: 130 });
  });

  it("settles subscribers when terminal persistence fails and repairs on reconnect", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let finish!: (value: { result: number }) => void;
    const evaluation = new Promise<{ result: number }>((resolve) => {
      finish = resolve;
    });
    const backend = new WorkerJavaScriptBackend({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                evaluate: (
                  _input: unknown,
                  bridge: {
                    assertResult(value: unknown): Promise<void>;
                    attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
                  },
                ) => evaluation.then((outcome) => evaluateResult(bridge, outcome.result)),
              };
            },
          };
        },
      },
    });
    const host = { db, fs, git: undefined as never, artifacts: undefined as never };
    const handle = await backend.connect(host);
    const execution = await handle.exec({ id: "storage-failure", source: "export default 1" });
    const originalRun = db.run.bind(db);
    db.run = ((query: string, ...bindings: unknown[]) => {
      if (query.includes("UPDATE workspace_runtime_executions")) {
        throw new Error("storage unavailable");
      }
      return originalRun(query, ...bindings);
    }) as typeof db.run;
    finish({ result: 1 });
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ name: "exit", code: 1 });
    const sameSessionReplay = await handle.getExec({ id: "storage-failure" });
    const sameSessionEvents = [];
    for await (const event of sameSessionReplay.events) sameSessionEvents.push(event);
    expect(sameSessionEvents.at(-1)).toMatchObject({ name: "exit", code: 1 });
    db.run = originalRun as typeof db.run;

    const reconnected = await backend.connect(host);
    const replay = await reconnected.getExec({ id: "storage-failure" });
    const repaired = [];
    for await (const event of replay.events) repaired.push(event);
    expect(repaired.at(-1)).toMatchObject({ name: "exit", code: 1 });
  });

  it("bounds durable completed-execution retention", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: throwingLoader("finished"),
          maxRetainedExecutions: 1,
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    for (const id of ["one", "two"]) {
      const execution = await workspace.runtime.exec("export default 1", { id });
      await execution.result();
    }
    const third = await workspace.runtime.exec("export default 1", { id: "three" });
    await third.result();
    await expect(workspace.runtime.getExec("one")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workspace.runtime.getExec("two")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workspace.runtime.getExec("three")).resolves.toBeDefined();
  });

  it("rejects cwd and execution ids outside their configured bounds", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load } })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(workspace.runtime.exec("export default 1", { cwd: "/outside" })).rejects.toThrow(
      /stay under \/workspace/,
    );
    await expect(
      workspace.runtime.exec("export default 1", { id: "x".repeat(257) }),
    ).rejects.toThrow(/id exceeds 256 bytes/);
    expect(load).not.toHaveBeenCalled();
  });

  it("caps unconsumed event subscribers per execution", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    const backend = new WorkerJavaScriptBackend({
      maxExecutionSubscribers: 2,
      loader: {
        load() {
          return {
            getEntrypoint() {
              return { evaluate: () => new Promise(() => undefined) };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    await handle.exec({ id: "subscribers", source: "export default 1" });
    await handle.getExec({ id: "subscribers", after: "tail" });
    const rejected = await handle.getExec({ id: "subscribers", after: "tail" });
    await expect(rejected.events.getReader().read()).rejects.toMatchObject({ code: "EEXEC_BUSY" });
    await handle.close();
  });

  it.each([
    ["a host module with a path", { "ws:bad/path": { run: async () => null } }, /simple ws:\*/],
    ["a host module outside ws:*", { container: { run: async () => null } }, /simple ws:\*/],
    ["source under ws:*", { "ws:lib": "export const x = 1;" }, /only for host modules/],
    ["a replacement node:fs", { "node:fs": "export default {};" }, /built in/],
    [
      "a replacement node:fs host module",
      { "node:fs/promises": { run: async () => null } },
      /built in/,
    ],
    ["a number", { "ws:test": 42 }, /source text, an object of functions, or a factory/],
    ["an object with no functions", { "ws:test": {} }, /must export a function/],
    [
      "an object with a non-identifier name",
      { "ws:test": { "not-a-name": async () => null } },
      /JavaScript identifier/,
    ],
    [
      "an object with a default export",
      { "ws:test": { default: async () => null } },
      /JavaScript identifier/,
    ],
    [
      "an object with a then export",
      // biome-ignore lint/suspicious/noThenProperty: The case checks that the backend rejects a `then` export.
      { "ws:test": { then: async () => null } },
      /JavaScript identifier/,
    ],
    ["an object with a non-function export", { "ws:test": { run: "nope" } }, /must be a function/],
  ])("rejects %s at construction", (_label, modules, message) => {
    expect(
      () =>
        new WorkerJavaScriptBackend({
          loader: throwingLoader("must not load"),
          // SAFETY: Each case hands the constructor a shape the types may forbid, to check its runtime guard.
          modules: modules as never,
        }),
    ).toThrow(message);
  });

  it("rejects a factory whose functions are not allowed when it connects", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      modules: { "ws:test": () => ({ "not-a-name": async () => null }) },
    });
    await expect(
      backend.connect({
        db,
        fs: new WorkspaceFilesystem(db),
        git: undefined as never,
        artifacts: undefined as never,
        runtime: undefined as never,
      }),
    ).rejects.toThrow(/JavaScript identifier/);
  });

  it("describes its modules for a model", () => {
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      access: "read",
      modules: {
        lib: "export const x = 1;",
        "ws:weather": { forecast: () => null, alerts: () => null },
        "ws:described": Object.assign(() => ({ run: () => null }), {
          description: "Does a thing.",
        }),
        "ws:plain": () => ({ run: () => null }),
      },
    });

    expect(backend.description).toContain("ECMAScript module source");
    expect(backend.description).toContain("read-only");
    expect(backend.description).toContain("- `lib`: a bundled library.");
    expect(backend.description).toContain("- `ws:weather`: exports `forecast`, `alerts`.");
    expect(backend.description).toContain("- `ws:described`: Does a thing.");
    expect(backend.description).toContain("- `ws:plain`: a host module.");
  });

  it("tells a model to put the work in a default-exported function", () => {
    const backend = new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") });

    expect(backend.description).toContain(
      "Put the work in `export default async function (input) { ... }` and call `node:fs` and the other modules below inside it, since the module's top level can't do I/O. To run a file you've already written, re-export it: `export { default } from \"./main.js\"`.",
    );
  });

  it("builds host modules from the Workspace services when it connects", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const git = { marker: "git" };
    let seen: unknown;
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      modules: {
        "ws:test": (host) => {
          seen = host.git;
          return { run: async () => null };
        },
      },
    });
    await backend.connect({
      db,
      fs: new WorkspaceFilesystem(db),
      git: git as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    expect(seen).toBe(git);
  });

  it("does not dispatch inherited members of a host module", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let response: unknown;
    const backend = new WorkerJavaScriptBackend({
      modules: { "ws:test": { run: async () => null } },
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(
                  _input: unknown,
                  host: { call(name: string, args: unknown[]): Promise<unknown> },
                ) {
                  response = await host.call("host/ws:test.toString", []);
                },
              };
            },
          };
        },
      },
    });
    const handle = await backend.connect({
      db,
      fs,
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    });
    const execution = await handle.exec({ id: "inherited", source: "export default 1" });
    for await (const _event of execution.events) {
      // Drain the run so the host call settles.
    }
    expect(response).toMatchObject({
      error: { message: expect.stringContaining("Unknown Workspace host module call") },
    });
    await handle.close?.();
  });

  it("does not install ws:git or ws:artifacts unless they are configured", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") })],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    for (const specifier of ["ws:git", "ws:artifacts"]) {
      await expect(
        workspace.runtime.exec(`import * as m from "${specifier}"; export default () => m;`),
      ).rejects.toThrow(/is not configured/);
    }
  });

  it("runs concurrent executions without a cap of its own", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: {
            load() {
              return {
                getEntrypoint() {
                  return {
                    evaluate: (
                      _input: unknown,
                      host: {
                        assertResult(value: unknown): Promise<void>;
                        attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
                      },
                    ) => {
                      started += 1;
                      return released.then(() => evaluateResult(host, 1));
                    },
                  };
                },
              };
            },
          },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const handles = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        workspace.runtime.exec("export default 1", { id: `run-${index}` }),
      ),
    );
    await vi.waitFor(() => expect(started).toBe(30));
    release();
    const results = await Promise.all(handles.map((handle) => handle.result()));
    expect(results.every((result) => result.status === "completed")).toBe(true);
    await workspace.close();
  });

  it("rejects relative imports that collide with internal Loader modules", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [new WorkerJavaScriptBackend({ loader: { load }, root: "/" })],
    });
    await workspace.fs.writeFile("/workspace-capabilities.js", "export const stolen = true");
    await expect(
      workspace.runtime.exec(`import "./workspace-capabilities.js"; export default 1;`, {
        cwd: "/",
      }),
    ).rejects.toThrow(/reserved for Workspace internals/);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["__workspace_entry__.js", "workspace-capabilities.js", "__modules__", "nested/lib"])(
    "rejects a source module named %s at construction",
    (specifier) => {
      expect(
        () =>
          new WorkerJavaScriptBackend({
            loader: throwingLoader("must not load"),
            modules: { [specifier]: "export default 42" },
          }),
      ).toThrow(/reserved module name/);
    },
  );
  describe("root directory", () => {
    const loader = {
      load: () => ({
        getEntrypoint: () => ({
          evaluate: (
            _input: unknown,
            host: {
              assertResult(value: unknown): Promise<void>;
              attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
            },
          ) => evaluateResult(host, null),
        }),
      }),
    };

    it("is created on the first run in a fresh Workspace", async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader })],
      });

      const execution = await workspace.runtime.exec("export default () => null;");
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      await expect(workspace.fs.stat("/workspace")).resolves.toMatchObject({ isDirectory: true });
    });

    it("is left alone by a read-only backend", async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader, access: "read" })],
      });

      const execution = await workspace.runtime.exec("export default () => null;");
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      await expect(workspace.fs.stat("/workspace")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("module resolution", () => {
    function completingLoader() {
      return vi.fn((_code: { modules: Record<string, string | { js?: string }> }) => ({
        getEntrypoint() {
          return {
            evaluate: (
              _input: unknown,
              host: {
                assertResult(value: unknown): Promise<void>;
                attachOutput(readable: ReadableStream<Uint8Array>): Promise<void>;
              },
            ) => evaluateResult(host, null),
          };
        },
      }));
    }

    function source(module: string | { js?: string } | undefined) {
      return typeof module === "string" ? module : module?.js;
    }

    it("stores each configured and host module once, however many directories import it", async () => {
      const load = completingLoader();
      const large = `export default ${JSON.stringify("x".repeat(1000))};`;
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            modules: { large, "ws:echo": { run: async () => null } },
          }),
        ],
      });
      await workspace.fs.mkdir("/workspace/a/b", { recursive: true });
      await workspace.fs.writeFile(
        "/workspace/a/one.js",
        `import "large"; import "ws:echo"; import "./b/two.js";`,
      );
      await workspace.fs.writeFile("/workspace/a/b/two.js", `import "large"; import "ws:echo";`);

      const execution = await workspace.runtime.exec(
        `import "large"; import "ws:echo"; import "./a/one.js";`,
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(Object.keys(modules).filter((name) => name.endsWith("large"))).toEqual([
        "__modules__/large",
      ]);
      expect(Object.keys(modules).filter((name) => name.endsWith("ws:echo"))).toEqual([
        "__modules__/ws:echo",
      ]);
      expect(source(modules["workspace/a/b/two.js"])).toBe(
        `import "../../../__modules__/large"; import "../../../__modules__/ws:echo";`,
      );
    });

    it("rewrites an absolute import to a path relative to its importer", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load } })],
      });
      await workspace.fs.mkdir("/workspace/shared", { recursive: true });
      await workspace.fs.writeFile("/workspace/shared/util.js", "export const value = 1;");

      const execution = await workspace.runtime.exec(
        `import { value } from "/workspace/shared/util.js"; export default value;`,
        { cwd: "/workspace/app" },
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(source(modules["workspace/app/__workspace_entry__.js"])).toBe(
        `import { value } from "../shared/util.js"; export default value;`,
      );
      expect(source(modules["workspace/shared/util.js"])).toBe("export const value = 1;");
    });

    it("confines absolute imports to the backend root", async () => {
      const load = vi.fn();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load } })],
      });
      await workspace.fs.mkdir("/outside", { recursive: true });
      await workspace.fs.writeFile("/outside/secret.js", "export default 1;");
      await workspace.fs.mkdir("/workspace", { recursive: true });

      await expect(
        workspace.runtime.exec(`import "/outside/secret.js"; export default 1;`),
      ).rejects.toThrow(/must stay under \/workspace/);
      expect(load).not.toHaveBeenCalled();
    });

    it("rejects an absolute import of the module directory", async () => {
      const load = vi.fn();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            root: "/",
            modules: { lib: "export default 1;" },
          }),
        ],
      });
      await workspace.fs.mkdir("/__modules__", { recursive: true });
      await workspace.fs.writeFile("/__modules__/lib", "export default 2;");

      await expect(
        workspace.runtime.exec(`import "/__modules__/lib"; export default 1;`, { cwd: "/" }),
      ).rejects.toThrow(/reserved for Workspace internals/);
      expect(load).not.toHaveBeenCalled();
    });

    it.each([
      [
        "a relative import of a Workspace file",
        `import "./helper.js";`,
        /imports "\.\/helper\.js", which is not a configured module/,
      ],
      [
        "an absolute import",
        `import "/workspace/helper.js";`,
        /imports "\/workspace\/helper\.js", which is not a configured module/,
      ],
      [
        "an unconfigured host module",
        `import "ws:missing";`,
        /imports "ws:missing", which is not configured/,
      ],
    ])("rejects a configured module with %s", async (_label, imports, message) => {
      const load = vi.fn();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load }, modules: { lib: imports } })],
      });
      await workspace.fs.mkdir("/workspace", { recursive: true });

      await expect(workspace.runtime.exec(`import "lib"; export default 1;`)).rejects.toThrow(
        message,
      );
      expect(load).not.toHaveBeenCalled();
    });

    it("rewrites a configured module's host module imports to its own directory", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            modules: {
              base: "export const value = 1;",
              facade: `import { value } from "base"; import { run } from "ws:echo"; export { value, run };`,
              "ws:echo": { run: async () => null },
            },
          }),
        ],
      });
      await workspace.fs.mkdir("/workspace", { recursive: true });

      const execution = await workspace.runtime.exec(`import "facade"; export default 1;`);
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(source(modules["__modules__/facade"])).toBe(
        `import { value } from "base"; import { run } from "./ws:echo"; export { value, run };`,
      );
    });
  });
});
