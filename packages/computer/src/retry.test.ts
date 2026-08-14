import type { ChangeEntry } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { WorkspaceTransportError } from "./transport-failure.js";
import type {
  SyncRetryIntent,
  SyncRetryScheduler,
  WorkspaceRetryPendingSyncResult,
} from "./workspace.js";
import { Workspace } from "./workspace.js";

class MemoryRetryScheduler implements SyncRetryScheduler {
  readonly intents = new Map<string, SyncRetryIntent>();
  readonly scheduled: SyncRetryIntent[] = [];
  readonly cleared: string[] = [];

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    return this.intents.get(backend);
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    this.intents.set(intent.backend, intent);
    this.scheduled.push(intent);
  }

  async clear(backend: string): Promise<void> {
    this.intents.delete(backend);
    this.cleared.push(backend);
  }
}

function retryBackend(options: {
  onExec(): void;
  fetchChanges: import("@cloudflare/computer-rpc").SyncRPC["fetchChanges"];
  close?: () => Promise<void>;
}): WorkspaceBackend {
  const sync: import("@cloudflare/computer-rpc").SyncRPC = {
    async push(input) {
      return { rev: 0, appliedPushCursor: { rev: input.senderRev, path: null } };
    },
    fetchChanges: options.fetchChanges,
    async readEntry() {
      return null;
    },
    async hasObjects(hashes) {
      return hashes;
    },
    fetchObjects() {
      return new ReadableStream({ start: (controller) => controller.close() });
    },
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
    },
    async pushObjects() {},
  };
  return {
    id: "sandbox",
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: {
          sync,
          shell: {
            async exec() {
              options.onExec();
              return {
                id: "command-1",
                events: new ReadableStream({
                  start(controller) {
                    controller.enqueue({ id: "command-1", seq: 1, name: "exit", code: 0 });
                    controller.close();
                  },
                }),
              };
            },
            async getExec() {
              throw new Error("not used");
            },
            async killExec() {},
            async disposeExec() {},
          },
        },
        close: options.close ?? (async () => {}),
      };
    },
  };
}

async function runCommand(ws: Workspace): Promise<WorkspaceRetryPendingSyncResult | undefined> {
  const handle = await ws.runtime.exec("build", { encoding: "utf8" });
  const result = await handle.result();
  expect(result.sync.status).toBe("pending");
  return undefined;
}

describe("Workspace durable pending-sync retries", () => {
  it("clears a lost runtime intent so the live runtime can schedule a new one", async () => {
    const scheduler = new MemoryRetryScheduler();
    let connects = 0;
    let replacementPulls = 0;
    let failLivePull = false;
    const backend: WorkspaceBackend = {
      id: "sandbox",
      type: "fake",
      async connect(): Promise<BackendHandle> {
        const connection = connects++;
        const runtimeId = connection === 0 ? "runtime-a" : "runtime-b";
        const sync = retryBackend({
          onExec() {},
          async fetchChanges() {
            if (connection === 0) {
              throw new WorkspaceTransportError("container exited during post-exec pull");
            }
            if (failLivePull) throw new Error("live runtime pull failed");
            replacementPulls++;
            return {
              currentCursor: { rev: 0, path: null },
              appliedPushCursor: { rev: 0, path: null },
              stream: new ReadableStream<ChangeEntry>({
                start(controller) {
                  controller.close();
                },
              }),
            };
          },
        });
        const handle = await sync.connect({} as never);
        return { ...handle, runtimeId };
      },
    };
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      retry: { initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      now: () => 5_000,
    });

    const handle = await ws.runtime.exec("build", { encoding: "utf8" });
    const result = await handle.result();

    expect(result.sync).toMatchObject({
      status: "pending",
      error: expect.stringContaining("container exited during post-exec pull"),
    });
    expect(replacementPulls).toBe(0);
    expect(scheduler.intents.get("sandbox")).toEqual({
      backend: "sandbox",
      runtimeId: "runtime-a",
      attempt: 1,
      notBefore: 5_100,
    });

    await expect(ws.retryPendingSync("sandbox")).resolves.toMatchObject({
      status: "lost",
      runtimeId: "runtime-a",
    });
    expect(replacementPulls).toBe(0);
    expect(scheduler.intents.has("sandbox")).toBe(false);
    expect(scheduler.cleared).toEqual(["sandbox"]);

    failLivePull = true;
    await runCommand(ws);
    expect(scheduler.intents.get("sandbox")).toEqual({
      backend: "sandbox",
      runtimeId: "runtime-b",
      attempt: 1,
      notBefore: 5_100,
    });
  });

  it("replaces a stale runtime intent when a live runtime pull becomes pending", async () => {
    const scheduler = new MemoryRetryScheduler();
    scheduler.intents.set("sandbox", {
      backend: "sandbox",
      runtimeId: "runtime-a",
      attempt: 3,
      notBefore: 0,
    });
    const base = retryBackend({
      onExec() {},
      async fetchChanges() {
        throw new Error("runtime-b pull failed");
      },
    });
    const backend: WorkspaceBackend = {
      ...base,
      async connect(host): Promise<BackendHandle> {
        return { ...(await base.connect(host)), runtimeId: "runtime-b" };
      },
    };
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      retry: { initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      now: () => 5_000,
    });

    await runCommand(ws);

    expect(scheduler.intents.get("sandbox")).toEqual({
      backend: "sandbox",
      runtimeId: "runtime-b",
      attempt: 1,
      notBefore: 5_100,
    });
  });

  it("schedules the exact durable retry intent after a post-command pull failure", async () => {
    const scheduler = new MemoryRetryScheduler();
    let execs = 0;
    const backend = retryBackend({
      onExec: () => execs++,
      async fetchChanges() {
        throw new Error("backend unavailable");
      },
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      retry: { initialDelayMs: 2_000, maxDelayMs: 30_000, maxAttempts: 4 },
      now: () => 10_000,
    });

    await runCommand(ws);

    expect(execs).toBe(1);
    expect(scheduler.scheduled).toEqual([{ backend: "sandbox", attempt: 1, notBefore: 12_000 }]);
  });

  it("resumes a partial batch from the persisted cursor and converges without rerunning the command", async () => {
    const scheduler = new MemoryRetryScheduler();
    const after: Array<{ rev: number; path: string | null } | undefined> = [];
    let fetches = 0;
    let execs = 0;
    const entries = Array.from(
      { length: 257 },
      (_, index): ChangeEntry => ({
        kind: "delete",
        rev: 1,
        path: `/generated/${index.toString().padStart(3, "0")}`,
        mtime: 1,
      }),
    );
    const backend = retryBackend({
      onExec: () => execs++,
      async fetchChanges(input) {
        after.push(input.after);
        fetches++;
        const remaining = entries.filter((entry) => {
          if (!input.after || input.after.rev < entry.rev) return true;
          return (
            input.after.rev === entry.rev &&
            input.after.path !== null &&
            entry.path > input.after.path
          );
        });
        return {
          currentCursor: { rev: 1, path: null },
          appliedPushCursor: { rev: 0, path: null },
          stream:
            fetches === 1
              ? new ReadableStream<ChangeEntry>({
                  pull(controller) {
                    const entry = remaining.shift();
                    if (entry !== undefined) {
                      controller.enqueue(entry);
                      return;
                    }
                    controller.error(new Error("lost after first batch"));
                  },
                })
              : new ReadableStream<ChangeEntry>({
                  start(controller) {
                    for (const entry of remaining) controller.enqueue(entry);
                    controller.close();
                  },
                }),
        };
      },
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      retry: { initialDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      now: () => 5_000,
    });

    await runCommand(ws);
    const retried = await ws.retryPendingSync("sandbox");

    expect(retried).toMatchObject({ status: "complete", applied: 1 });
    expect(execs).toBe(1);
    expect(after).toEqual([
      { rev: 0, path: null },
      { rev: 1, path: "/generated/255" },
    ]);
    expect(scheduler.intents.size).toBe(0);
    expect(scheduler.cleared).toEqual(["sandbox"]);
  });

  it("coalesces repeated command failures into one pending intent per backend", async () => {
    const scheduler = new MemoryRetryScheduler();
    const backend = retryBackend({
      onExec() {},
      async fetchChanges() {
        throw new Error("still unavailable");
      },
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      now: () => 1_000,
    });

    await Promise.all([runCommand(ws), runCommand(ws)]);

    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.intents.size).toBe(1);
  });

  it("reschedules with bounded exponential backoff and leaves exhaustion visible", async () => {
    const scheduler = new MemoryRetryScheduler();
    const backend = retryBackend({
      onExec() {},
      async fetchChanges() {
        throw new Error("still unavailable");
      },
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
      retry: { initialDelayMs: 100, maxDelayMs: 150, maxAttempts: 3 },
      now: () => 1_000,
    });

    await runCommand(ws);
    expect(await ws.retryPendingSync()).toMatchObject({ status: "pending", attempt: 2 });
    expect(await ws.retryPendingSync()).toMatchObject({ status: "pending", attempt: 3 });
    expect(await ws.retryPendingSync()).toMatchObject({ status: "exhausted", attempt: 3 });

    expect(scheduler.scheduled).toEqual([
      { backend: "sandbox", attempt: 1, notBefore: 1_100 },
      { backend: "sandbox", attempt: 2, notBefore: 1_150 },
      { backend: "sandbox", attempt: 3, notBefore: 1_150 },
    ]);
    expect(scheduler.intents.get("sandbox")).toEqual({
      backend: "sandbox",
      attempt: 3,
      notBefore: 1_150,
    });
  });

  it("disposes a failed retry envelope and closes its RPC handle", async () => {
    const scheduler = new MemoryRetryScheduler();
    let closes = 0;
    let disposals = 0;
    const backend = retryBackend({
      onExec() {},
      async fetchChanges() {
        return {
          currentCursor: { rev: 1, path: null },
          appliedPushCursor: { rev: 0, path: null },
          stream: new ReadableStream<ChangeEntry>({
            start(controller) {
              controller.error(new Error("cancel retry stream"));
            },
          }),
          [Symbol.dispose]() {
            disposals++;
          },
        };
      },
      close: async () => {
        closes++;
      },
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [backend],
      retryScheduler: scheduler,
    });
    scheduler.intents.set("sandbox", { backend: "sandbox", attempt: 1, notBefore: 0 });

    await expect(ws.retryPendingSync()).resolves.toMatchObject({ status: "pending" });
    await ws.close();

    expect(disposals).toBe(1);
    expect(closes).toBe(1);
  });
});
