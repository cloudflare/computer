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
    await backend.connect({ db, fs, git: undefined as never, artifacts: undefined as never });
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

  it("limits concurrent Dynamic Workers", async () => {
    let resolveEvaluation!: (value: { result: number }) => void;
    const evaluation = new Promise<{ result: number }>((resolve) => {
      resolveEvaluation = resolve;
    });
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          maxConcurrentExecutions: 1,
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
                    ) => evaluation.then((outcome) => evaluateResult(host, outcome.result)),
                  };
                },
              };
            },
          },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const first = await workspace.runtime.exec("export default 1", { id: "first" });
    await expect(
      workspace.runtime.exec("export default 2", { id: "second" }),
    ).rejects.toMatchObject({ code: "EEXEC_BUSY" });
    resolveEvaluation({ result: 1 });
    await expect(first.result()).resolves.toMatchObject({ status: "completed" });
    await expect(
      workspace.runtime.exec("export default 2", { id: "second" }),
    ).resolves.toBeDefined();
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
                  void host.call("fs.writeFile", JSON.stringify(["/workspace/output.txt", "done"]));
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
    });
    const execution = await handle.exec({ id: "no-exit", source: "export default 1" });
    const events = [];
    for await (const event of execution.events) events.push(event);
    const exit = events.find((event) => event.name === "exit");
    expect(exit).toMatchObject({ name: "exit", code: 1 });
    expect(events.some((event) => event.name === "result")).toBe(false);
    await handle.close();
  });

  it("aborts cooperative trusted-module calls at their deadline", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const fs = new WorkspaceFilesystem(db);
    await fs.mkdir("/workspace", { recursive: true });
    let aborted = false;
    const backend = new WorkerJavaScriptBackend({
      maxHostCallMs: 5,
      trustedModules: {
        "ws:test": {
          call(_method, _args, context) {
            return new Promise((_resolve, reject) => {
              context?.signal.addEventListener("abort", () => {
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
                  host: { call(name: string, args: string): Promise<string> },
                ) {
                  await host.call("trusted/ws:test.call", JSON.stringify(["run"]));
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
                  host: { call(name: string, args: string): Promise<string> },
                ) {
                  void host.call("fs.writeFile", JSON.stringify(["/workspace/output.txt", "done"]));
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
    });
    await handle.exec({ id: "subscribers", source: "export default 1" });
    await handle.getExec({ id: "subscribers", after: "tail" });
    const rejected = await handle.getExec({ id: "subscribers", after: "tail" });
    await expect(rejected.events.getReader().read()).rejects.toMatchObject({ code: "EEXEC_BUSY" });
    await handle.close();
  });

  it("rejects malformed host trusted-module names", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: throwingLoader("must not load"),
          trustedModules: {
            "ws:bad/path": {
              async call() {
                return null;
              },
            },
          } as never,
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec(`import { call } from "ws:bad/path"; export default call;`, {
        backend: "worker-javascript",
      }),
    ).rejects.toThrow(/simple reserved ws:\*/);
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

  it("rejects configured module names that collide with generated modules", async () => {
    const load = vi.fn();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        new WorkerJavaScriptBackend({
          loader: { load },
          modules: {
            "__workspace_entry__.js": "export default 42",
            "node:fs": "export default {};",
          },
        }),
      ],
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await expect(
      workspace.runtime.exec("export default 1", { backend: "worker-javascript" }),
    ).rejects.toThrow(/reserved module name/);
    expect(load).not.toHaveBeenCalled();
  });
});
