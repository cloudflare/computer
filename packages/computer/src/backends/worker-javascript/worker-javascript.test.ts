import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRuntimeLoader } from "../../runtime/types.js";
import { Workspace } from "../../workspace.js";
import { ExecutionJournal, fingerprint, loadResume } from "./journal.js";
import { runtimeCode, WorkerJavaScriptBackend } from "./worker-javascript.js";

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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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
    const gateway = { fetch: vi.fn<Fetcher["fetch"]>() } as unknown as Fetcher;
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
    const dispose = vi.fn<() => void>();
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
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
      // oxlint-disable-next-line unicorn/no-thenable -- The case checks that the backend rejects a `then` export.
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

  it("lists the Node.js built-ins code can import", () => {
    const backend = new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") });

    expect(backend.description).toContain(
      "- Node.js built-ins: `node:path`, `node:url`, `node:util`,",
    );
    expect(backend.description).toContain("Bare names such as `path` work too.");
  });

  it("lists no Node.js built-ins without the nodejs_compat flag", () => {
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      compatibilityFlags: [],
    });

    expect(backend.description).not.toContain("Node.js built-ins");
  });

  it("tells a model to put the work in a default-exported function", () => {
    const backend = new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") });

    expect(backend.description).toContain(
      "Put the work in `export default async function (input) { ... }` and call `node:fs` and the other modules below inside it, since the module's top level can't do I/O. To run a file you've already written, re-export it: `export { default } from \"./main.js\"`.",
    );
  });

  it("reads a factory's description each time it describes itself", () => {
    let names = ["read"];
    const factory = Object.defineProperty(() => ({ run: () => null }), "description", {
      get: () => `Tools: ${names.join(", ")}.`,
    });
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      modules: { "ws:tools": factory },
    });

    expect(backend.description).toContain("- `ws:tools`: Tools: read.");
    names = ["read", "grep"];
    expect(backend.description).toContain("- `ws:tools`: Tools: read, grep.");
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

  it("hands host modules the Workspace's assets client", async () => {
    const db = new Database(new SQLiteTestStorage());
    initializeSchema(db, () => 0);
    const assets = { marker: "assets" };
    const seen: unknown[] = [];
    const backend = new WorkerJavaScriptBackend({
      loader: throwingLoader("must not load"),
      modules: {
        "ws:test": (host) => {
          seen.push(host.assets);
          return { run: async () => null };
        },
      },
    });
    const host = {
      db,
      fs: new WorkspaceFilesystem(db),
      git: undefined as never,
      artifacts: undefined as never,
      runtime: undefined as never,
    };
    await backend.connect({ ...host, assets: assets as never });
    await backend.connect(host);
    expect(seen).toEqual([assets, undefined]);
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

  describe("keep-alive", () => {
    function gatedWorkspace(options: { keepAliveIntervalMs?: number } = {}) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            ...options,
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
      return { workspace, release, started: () => started };
    }

    it("keeps a timer scheduled while an execution runs and clears it once none do", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        const { workspace, release, started } = gatedWorkspace();
        await workspace.fs.mkdir("/workspace", { recursive: true });
        const first = await workspace.runtime.exec("export default 1", { id: "first" });
        const second = await workspace.runtime.exec("export default 1", { id: "second" });
        await vi.waitFor(() => expect(started()).toBe(2));

        const keepAliveCalls = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000);
        expect(keepAliveCalls).toHaveLength(1);
        const timer =
          setIntervalSpy.mock.results[setIntervalSpy.mock.calls.indexOf(keepAliveCalls[0])]?.value;
        expect(clearIntervalSpy).not.toHaveBeenCalledWith(timer);

        release();
        await first.result();
        await second.result();
        expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
        await workspace.close();
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it("stops keeping the object alive for a run stuck finalizing past its timeout and host call deadline", async () => {
      const db = new Database(new SQLiteTestStorage());
      initializeSchema(db, () => 0);
      const fs = new WorkspaceFilesystem(db);
      await fs.mkdir("/workspace", { recursive: true });
      let callStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        callStarted = resolve;
      });
      let releaseWrite!: () => void;
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const originalWrite = fs.writeFile.bind(fs);
      fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
        callStarted();
        await writeReleased;
        return originalWrite(...args);
      }) as typeof fs.writeFile;
      let now = 1_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        const backend = new WorkerJavaScriptBackend({
          maxTimeoutMs: 10_000,
          maxHostCallMs: 5_000,
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
        await handle.exec({ id: "stuck", source: "export default 1", timeoutMs: 10_000 });
        await started;
        // The kill waits for the write, which never settles on its own.
        const kill = handle.killExec({ id: "stuck" });

        const call = setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === 60_000);
        const [tick] = setIntervalSpy.mock.calls[call] ?? [];
        const timer = setIntervalSpy.mock.results[call]?.value;
        expect(tick).toBeTypeOf("function");

        now += 15_000;
        (tick as () => void)();
        expect(clearIntervalSpy).not.toHaveBeenCalledWith(timer);

        now += 1;
        (tick as () => void)();
        expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

        releaseWrite();
        await kill;
        await handle.close();
      } finally {
        nowSpy.mockRestore();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it("schedules no timer when keepAliveIntervalMs is 0", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      try {
        const { workspace, release, started } = gatedWorkspace({ keepAliveIntervalMs: 0 });
        await workspace.fs.mkdir("/workspace", { recursive: true });
        const handle = await workspace.runtime.exec("export default 1");
        await vi.waitFor(() => expect(started()).toBe(1));
        expect(setIntervalSpy).not.toHaveBeenCalled();
        release();
        await handle.result();
        await workspace.close();
      } finally {
        setIntervalSpy.mockRestore();
      }
    });

    // The timer's id from the one setInterval call the keep-alive makes.
    function keepAliveTimer(setIntervalSpy: {
      mock: { calls: unknown[][]; results: { value: unknown }[] };
    }) {
      const call = setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === 60_000);
      expect(call).not.toBe(-1);
      return setIntervalSpy.mock.results[call]?.value;
    }

    it("clears the timer when the last execution is killed", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        const { workspace, started } = gatedWorkspace();
        await workspace.fs.mkdir("/workspace", { recursive: true });
        const handle = await workspace.runtime.exec("export default 1", { id: "killed" });
        await vi.waitFor(() => expect(started()).toBe(1));
        const timer = keepAliveTimer(setIntervalSpy);
        await workspace.runtime.killExec("killed");
        await expect(handle.result()).resolves.toMatchObject({ status: "cancelled" });
        expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
        await workspace.close();
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it("clears the timer when the Workspace closes with executions running", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        const { workspace, started } = gatedWorkspace();
        await workspace.fs.mkdir("/workspace", { recursive: true });
        await workspace.runtime.exec("export default 1");
        await workspace.runtime.exec("export default 1");
        await vi.waitFor(() => expect(started()).toBe(2));
        const timer = keepAliveTimer(setIntervalSpy);
        await workspace.close();
        expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
    });

    it("schedules no timer when the host's pending work can't keep the object in memory", async () => {
      vi.stubGlobal("Cloudflare", {
        compatibilityFlags: { durable_object_io_tasks_prevent_eviction: false },
      });
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      try {
        const { workspace, release, started } = gatedWorkspace();
        await workspace.fs.mkdir("/workspace", { recursive: true });
        const handle = await workspace.runtime.exec("export default 1");
        await vi.waitFor(() => expect(started()).toBe(1));
        expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(0);
        release();
        await handle.result();
        await workspace.close();
      } finally {
        setIntervalSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("schedules the timer when the host's pending work keeps the object in memory", async () => {
      vi.stubGlobal("Cloudflare", {
        compatibilityFlags: { durable_object_io_tasks_prevent_eviction: true },
      });
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      try {
        const { workspace, release, started } = gatedWorkspace();
        await workspace.fs.mkdir("/workspace", { recursive: true });
        const handle = await workspace.runtime.exec("export default 1");
        await vi.waitFor(() => expect(started()).toBe(1));
        keepAliveTimer(setIntervalSpy);
        release();
        await handle.result();
        await workspace.close();
      } finally {
        setIntervalSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it("rejects a keepAliveIntervalMs that is negative, non-finite, or 15 minutes or more", () => {
      for (const keepAliveIntervalMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 900_000]) {
        expect(
          () =>
            new WorkerJavaScriptBackend({ loader: throwingLoader("unused"), keepAliveIntervalMs }),
        ).toThrow(/keepAliveIntervalMs/);
      }
    });
  });

  describe("CPU limit", () => {
    function recordingLoader() {
      return vi.fn<WorkspaceRuntimeLoader["load"]>(() => ({
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

    it("defaults the CPU limit to the execution timeout", async () => {
      const load = recordingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load } })],
      });
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await (await workspace.runtime.exec("export default null", { timeoutMs: 45_000 })).result();
      expect(load.mock.calls[0]?.[0]).toMatchObject({ limits: { cpuMs: 45_000 } });
      await workspace.close();
    });

    it("caps the CPU limit at maxCpuMs without shortening the timeout", async () => {
      const load = recordingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            maxTimeoutMs: 60 * 60_000,
            maxCpuMs: 300_000,
          }),
        ],
      });
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await (
        await workspace.runtime.exec("export default null", { timeoutMs: 30 * 60_000 })
      ).result();
      expect(load.mock.calls[0]?.[0]).toMatchObject({ limits: { cpuMs: 300_000 } });
      await workspace.close();
    });

    it("rejects a maxCpuMs that is not positive and finite", () => {
      expect(
        () => new WorkerJavaScriptBackend({ loader: throwingLoader("unused"), maxCpuMs: 0 }),
      ).toThrow(/maxCpuMs/);
    });
  });

  it("rejects relative imports that collide with internal Loader modules", async () => {
    const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
      return vi.fn<WorkspaceRuntimeLoader["load"]>(
        (_code: { modules: Record<string, string | { js?: string }> }) => ({
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
        }),
      );
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
        `import "large"; import "ws:echo"; import "./a/one.js"; export default null;`,
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

    it("leaves a Node.js built-in import for the runtime to resolve", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load } })],
      });

      const execution = await workspace.runtime.exec(
        `import { join } from "node:path"; import { createHash } from "node:crypto"; export default null;`,
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(source(modules["workspace/__workspace_entry__.js"])).toBe(
        `import { join } from "node:path"; import { createHash } from "node:crypto"; export default null;`,
      );
    });

    it("points a bare Node.js built-in name at its node: module", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load } })],
      });

      const execution = await workspace.runtime.exec(
        `import path from "path"; import { inspect } from "util"; export default null;`,
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(source(modules["workspace/__workspace_entry__.js"])).toBe(
        `import path from "node:path"; import { inspect } from "node:util"; export default null;`,
      );
    });

    it("prefers a configured module over a Node.js built-in of the same name", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            modules: { events: "export const mine = true;" },
          }),
        ],
      });

      const execution = await workspace.runtime.exec(
        `import { mine } from "events"; export default mine;`,
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });

      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(source(modules["workspace/__workspace_entry__.js"])).toBe(
        `import { mine } from "../__modules__/events"; export default mine;`,
      );
    });

    it.each(["node:child_process", "node:net", "node:process", "child_process"])(
      "rejects %s, which is not one of the Node.js built-ins it allows",
      async (specifier) => {
        const workspace = new Workspace({
          storage: new SQLiteTestStorage(),
          backends: [new WorkerJavaScriptBackend({ loader: { load: completingLoader() } })],
        });

        await expect(
          workspace.runtime.exec(`import ${JSON.stringify(specifier)}; export default null;`),
        ).rejects.toThrow(`Module ${JSON.stringify(specifier)} is not configured`);
      },
    );

    it("rejects Node.js built-ins without the nodejs_compat flag", async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load: completingLoader() },
            compatibilityFlags: [],
          }),
        ],
      });

      await expect(
        workspace.runtime.exec(`import "node:path"; export default null;`),
      ).rejects.toThrow('Module "node:path" is not configured');
    });

    it("leaves out a factory that builds no functions, so runs that do not import it still start", async () => {
      const load = completingLoader();
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [
          new WorkerJavaScriptBackend({
            loader: { load },
            modules: { "ws:tools": () => ({}), "ws:other": { run: async () => null } },
          }),
        ],
      });

      const execution = await workspace.runtime.exec(
        `import { run } from "ws:other"; export default run;`,
      );
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });
      const modules = load.mock.calls[0]?.[0].modules ?? {};
      expect(Object.keys(modules).filter((name) => name.includes("ws:"))).toEqual([
        "__modules__/ws:other",
      ]);

      await expect(
        workspace.runtime.exec(`import { read } from "ws:tools"; export default read;`),
      ).rejects.toThrow(
        'Module "ws:tools" exports nothing on this backend: its factory built no functions when the backend connected.',
      );
    });

    it("rejects a module with no default export before loading it", async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: throwingLoader("must not load") })],
      });

      await expect(workspace.runtime.exec(`const x = 1;`)).rejects.toThrow(
        'The module has no default export, so there is nothing to run. Put the work in `export default async function (input) { ... }`, or re-export one with `export { default } from "./main.js"`.',
      );
      await expect(
        workspace.runtime.exec(`export function main() {} export const a = 1, b = 2;`),
      ).rejects.toThrow("The module exports `main`, `a`, and `b` but no default");
    });

    it.each([
      ["a default export", `export default 1;`],
      ["a named default", `function main() {} export { main as default };`],
      ["a re-exported default", `export { default } from "./main.js";`],
    ])("runs a module with %s", async (_label, source) => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [new WorkerJavaScriptBackend({ loader: { load: completingLoader() } })],
      });
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await workspace.fs.writeFile("/workspace/main.js", "export default 1;");

      const execution = await workspace.runtime.exec(source);
      await expect(execution.result()).resolves.toMatchObject({ status: "completed" });
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
      const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
      const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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
      const load = vi.fn<WorkspaceRuntimeLoader["load"]>();
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

describe("WorkerJavaScriptBackend interrupted executions", () => {
  const hanging = {
    load() {
      return {
        getEntrypoint() {
          return { evaluate: () => new Promise<void>(() => undefined) };
        },
      };
    },
  };

  function open(
    storage: SQLiteTestStorage,
    options: Partial<ConstructorParameters<typeof WorkerJavaScriptBackend>[0]> = {},
  ) {
    return new Workspace({
      storage,
      backends: [new WorkerJavaScriptBackend({ loader: hanging, ...options })],
    });
  }

  async function interrupt(storage: SQLiteTestStorage, timeoutMs?: number) {
    const workspace = open(storage);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.runtime.exec("export default 1", {
      backend: "worker-javascript",
      id: "run",
      onInterrupt: "replay",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return workspace;
  }

  async function settle(workspace: Workspace) {
    const handle = await workspace.runtime.getExec("run", {
      backend: "worker-javascript",
      encoding: "utf8",
    });
    return handle.result();
  }

  it("saves the event log an output frame carries along with the output", async () => {
    const storage = new SQLiteTestStorage();
    let whileRunning: unknown[] = [];
    const workspace = new Workspace({
      storage,
      backends: [
        new WorkerJavaScriptBackend({
          onInterrupt: "replay",
          loader: {
            load() {
              return {
                getEntrypoint() {
                  return {
                    async evaluate(
                      _input: unknown,
                      host: { attachOutput(readable: ReadableStream<Uint8Array>): Promise<void> },
                    ) {
                      const encoder = new TextEncoder();
                      let output!: ReadableStreamDefaultController<Uint8Array>;
                      const drained = host.attachOutput(
                        new ReadableStream({ start: (controller) => void (output = controller) }),
                      );
                      const frame = {
                        name: "stdout",
                        b64: btoa("tick\n"),
                        log: { from: 0, events: [-1] },
                      };
                      output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
                      await new Promise((resolve) => setTimeout(resolve, 10));
                      const db = new Database(storage);
                      whileRunning = [
                        db.all("SELECT position, events FROM workspace_runtime_event_log"),
                        db.all("SELECT name FROM workspace_runtime_events"),
                      ];
                      output.enqueue(
                        encoder.encode(`${JSON.stringify({ name: "exit", code: 0 })}\n`),
                      );
                      output.close();
                      await drained;
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
    const handle = await workspace.runtime.exec("export default 1", {
      backend: "worker-javascript",
    });
    await expect(handle.result()).resolves.toMatchObject({ status: "completed" });
    expect(whileRunning).toEqual([[{ position: 0, events: "[-1]" }], [{ name: "stdout" }]]);
    await workspace.close();
  });

  it("fails a run after three attempts", async () => {
    const storage = new SQLiteTestStorage();
    const workspaces = [await interrupt(storage)];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workspace = open(storage);
      await workspace.runtime.recover();
      workspaces.push(workspace);
    }
    const last = open(storage);
    await expect(settle(last)).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("interrupted 3 times"),
    });
    for (const workspace of [...workspaces, last]) await workspace.close();
  });

  it("counts attempts from the last call the run journaled", async () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    const workspaces = [await interrupt(storage)];
    const recover = async () => {
      const workspace = open(storage);
      await workspace.runtime.recover();
      workspaces.push(workspace);
      return loadResume(db, "worker-javascript", "run")?.attempt;
    };
    expect(await recover()).toBe(2);
    expect(await recover()).toBe(3);
    // The run journals a call, so its next interruption starts the count again.
    const journal = new ExecutionJournal(db, "worker-javascript", "run");
    const step = journal.begin("fs.readFile", ["/a"]);
    if (step.kind !== "live") throw new Error("expected a live call");
    journal.commit(step.seq, { result: "a" });
    expect(await recover()).toBe(2);
    expect(await recover()).toBe(3);
    const last = open(storage);
    await expect(settle(last)).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("interrupted 3 times without making progress"),
    });
    for (const workspace of [...workspaces, last]) await workspace.close();
  });

  it("starts a run's attempts again once its wait is answered", async () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    const workspaces = [await interrupt(storage)];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const workspace = open(storage);
      await workspace.runtime.recover();
      workspaces.push(workspace);
    }
    expect(loadResume(db, "worker-javascript", "run")?.attempt).toBe(3);
    // The run's next call waits for an answer.
    const journal = new ExecutionJournal(db, "worker-javascript", "run");
    const step = journal.begin("host/ws:test.approve", []);
    if (step.kind !== "live") throw new Error("expected a live call");
    journal.interrupt(step.seq, { kind: "approval" });
    const answering = open(storage);
    workspaces.push(answering);
    await answering.runtime.respond("run", `run:${step.seq}`, true);
    expect(loadResume(db, "worker-javascript", "run")?.attempt).toBe(1);
    for (const workspace of workspaces) await workspace.close();
  });

  it("asks for a REPLAY_VERSION check when the runtime's code changes", () => {
    // The code the runtime loads into the isolate changed. If a run that
    // started on the old code could replay differently on the new code,
    // bump REPLAY_VERSION in journal.ts. Either way, update this digest.
    expect(fingerprint(runtimeCode("main.js", 1024, 1024))).toBe("v1:0fb1pjqz8570ofg1opq2fb:31550");
  });

  it("fails a run when the runtime changed under it", async () => {
    const storage = new SQLiteTestStorage();
    const first = await interrupt(storage);
    const changed = open(storage, { maxStdioBytes: 2048 });
    await expect(settle(changed)).resolves.toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("runtime changed since it started"),
    });
    await changed.close();
    await first.close();
  });

  it("fails a run whose timeout passed while it was interrupted", async () => {
    const storage = new SQLiteTestStorage();
    const first = await interrupt(storage, 1000);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    try {
      const later = open(storage);
      await expect(settle(later)).resolves.toMatchObject({
        status: "failed",
        stderr: expect.stringContaining("timeout passed"),
      });
      await later.close();
    } finally {
      clock.mockRestore();
    }
    await first.close();
  });

  it("journals a run's calls and removes them once it settles", async () => {
    const storage = new SQLiteTestStorage();
    let whileRunning: unknown[] = [];
    const workspace = new Workspace({
      storage,
      backends: [
        new WorkerJavaScriptBackend({
          onInterrupt: "replay",
          loader: {
            load() {
              return {
                getEntrypoint() {
                  return {
                    async evaluate(
                      _input: unknown,
                      host: Parameters<typeof evaluateResult>[0] & {
                        call(name: string, args: unknown[]): Promise<unknown>;
                      },
                    ) {
                      await host.call("fs.writeFile", ["/workspace/out.txt", "x"]);
                      whileRunning = new Database(storage).all(
                        "SELECT label, state FROM workspace_runtime_journal",
                      );
                      await evaluateResult(host, 1);
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
    const handle = await workspace.runtime.exec("export default 1", {
      backend: "worker-javascript",
    });
    await expect(handle.result()).resolves.toMatchObject({ status: "completed", value: 1 });
    expect(whileRunning).toEqual([
      { label: 'fs.writeFile("/workspace/out.txt", "x")', state: "applied" },
    ]);
    const db = new Database(storage);
    for (const table of [
      "workspace_runtime_resume",
      "workspace_runtime_resume_start",
      "workspace_runtime_journal",
    ]) {
      expect(db.all(`SELECT * FROM ${table}`), table).toEqual([]);
    }
    await workspace.close();
  });

  it("restarts at most four interrupted runs at once", async () => {
    const storage = new SQLiteTestStorage();
    const first = open(storage);
    await first.fs.mkdir("/workspace", { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      await first.runtime.exec("export default 1", {
        backend: "worker-javascript",
        id: `run-${index}`,
        onInterrupt: "replay",
      });
    }
    let launched = 0;
    const later = open(storage, {
      loader: {
        load() {
          launched += 1;
          return hanging.load();
        },
      },
    });
    await later.runtime.recover();
    await vi.waitFor(() => expect(launched).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launched).toBe(4);
    // Each run that settles lets a waiting one start.
    await later.runtime.killExec("run-0", { backend: "worker-javascript" });
    await vi.waitFor(() => expect(launched).toBe(5));
    await later.close();
    await first.close();
  });

  it("rejects an unknown onInterrupt policy", async () => {
    expect(
      () => new WorkerJavaScriptBackend({ loader: hanging, onInterrupt: "maybe" as never }),
    ).toThrow('onInterrupt must be "fail", "restart" or "replay".');
    const workspace = open(new SQLiteTestStorage());
    await expect(
      workspace.runtime.exec("export default 1", {
        backend: "worker-javascript",
        onInterrupt: "maybe" as never,
      }),
    ).rejects.toThrow("onInterrupt must be");
    await workspace.close();
  });
});
