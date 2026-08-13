// Unit tests for CommandExecutor. The harness shell.test.ts under
// src/test-harness covers the wire end-to-end against a real computerd
// container; these tests run in-process with a fake WorkspaceRPC so
// the host-side executor (RPC forwarding, envelope shape, push/pull
// bracket math, reattach) is exercised without needing Docker.
//
// Encoding and result accumulation are the runtime's job now — the
// executor returns raw events and the runtime drains them — so those
// cases live in runtime.test.ts, not here.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { describe, expect, it } from "vitest";

import { CommandExecutor, type KillSignal, type Sync } from "./shell.js";

// Inert sync impl. Tests that don't exercise the bracket use a Sync
// that returns 0 from both halves. Tests that do build their own.
function applied(n: number) {
  return { applied: n, skipped: [] };
}

function makeSync(): Sync {
  return {
    async push() {
      return 0;
    },
    async pull() {
      return applied(0);
    },
  };
}

interface ExecCall {
  source: string;
  id: string | undefined;
  cwd: string | undefined;
  timeoutMs: number | undefined;
}

interface GetExecCall {
  id: string;
  after: number | "tail" | undefined;
}

interface KillExecCall {
  id: string;
  signal: KillSignal | undefined;
}

interface FakeRpc {
  rpc: WorkspaceRPC;
  calls: {
    exec: ExecCall[];
    getExec: GetExecCall[];
    killExec: KillExecCall[];
  };
}

interface FakeRpcOptions {
  events?: ExecEvent[];
  throwOnExec?: Error;
  streamError?: Error;
  mintedId?: string;
}

function fakeRpc(options: FakeRpcOptions = {}): FakeRpc {
  const events = options.events ?? [{ id: "_", seq: 1, name: "exit", code: 0 }];
  const mintedId = options.mintedId ?? "runner-minted-id";
  const calls: FakeRpc["calls"] = { exec: [], getExec: [], killExec: [] };

  function makeStream(id: string): ReadableStream<ExecEvent> {
    return new ReadableStream<ExecEvent>({
      start(c) {
        for (const e of events) c.enqueue({ ...e, id });
        if (options.streamError !== undefined) {
          c.error(options.streamError);
          return;
        }
        c.close();
      },
    });
  }

  const sync: SyncRPC = {
    async push() {
      throw new Error("not wired");
    },
    async fetchChanges() {
      throw new Error("not wired");
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
      throw new Error("not wired");
    },
    async pushObjects() {
      throw new Error("not wired");
    },
  };

  const shell: ShellRPC = {
    async exec(input) {
      calls.exec.push({
        source: input.source,
        id: input.id,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      if (options.throwOnExec !== undefined) throw options.throwOnExec;
      const id = input.id ?? mintedId;
      return { id, events: makeStream(id) };
    },
    async getExec(input) {
      calls.getExec.push({ id: input.id, after: input.after });
      return { id: input.id, events: makeStream(input.id) };
    },
    async killExec(input) {
      calls.killExec.push({ id: input.id, signal: input.signal as KillSignal | undefined });
    },
    async disposeExec() {},
  };

  return { rpc: { sync, shell }, calls };
}

function stdout(seq: number, text: string): ExecEvent {
  return { id: "_", seq, name: "stdout", value: new TextEncoder().encode(text) };
}
function exit(seq: number, code: number): ExecEvent {
  return { id: "_", seq, name: "exit", code: code };
}

// Drain an execution's events to completion and settle its sync
// outcome, mirroring what the runtime does when it wraps the handle.
async function drain(execution: {
  events: ReadableStream<ExecEvent>;
  sync: { pushed: number; outcome: Promise<unknown> };
}) {
  const seen: ExecEvent[] = [];
  const reader = execution.events.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const outcome = await execution.sync.outcome;
  return { seen, pushed: execution.sync.pushed, outcome };
}

describe("CommandExecutor.exec — RPC forwarding", () => {
  it("forwards the source verbatim", async () => {
    const f = fakeRpc();
    const shell = new CommandExecutor(f.rpc.shell, makeSync());
    await shell.exec("echo hi && exit 0");
    expect(f.calls.exec).toHaveLength(1);
    expect(f.calls.exec[0].source).toBe("echo hi && exit 0");
  });

  it("forwards an explicit id", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop", { id: "stable-id" });
    expect(f.calls.exec[0].id).toBe("stable-id");
  });

  it("omits id from the RPC when the caller doesn't supply one", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop");
    expect(f.calls.exec[0].id).toBeUndefined();
  });

  it("forwards cwd", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop", { cwd: "/workspace/sub" });
    expect(f.calls.exec[0].cwd).toBe("/workspace/sub");
  });

  it("forwards timeoutMs", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop", { timeoutMs: 1000 });
    expect(f.calls.exec[0].timeoutMs).toBe(1000);
  });

  it("forwards timeoutMs: 0 to disable the timeout", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop", { timeoutMs: 0 });
    expect(f.calls.exec[0].timeoutMs).toBe(0);
  });

  it("leaves timeoutMs undefined when the caller omits it", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop");
    expect(f.calls.exec[0].timeoutMs).toBeUndefined();
  });

  it("uses the id the runner returned, not the caller-supplied one", async () => {
    const f = fakeRpc({ mintedId: "from-runner" });
    const execution = await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop");
    expect(execution.id).toBe("from-runner");
  });

  it("propagates errors from shell.exec; the pre-spawn push ran, the post-drain pull did not", async () => {
    const f = fakeRpc({ throwOnExec: new Error("EEXEC_BUSY") });
    let pushCalls = 0;
    let pullCalls = 0;
    const sync: Sync = {
      async push() {
        pushCalls += 1;
        return 0;
      },
      async pull() {
        pullCalls += 1;
        return applied(0);
      },
    };
    await expect(new CommandExecutor(f.rpc.shell, sync).exec("noop")).rejects.toThrow("EEXEC_BUSY");
    expect(pushCalls).toBe(1);
    expect(pullCalls).toBe(0);
  });
});

describe("CommandExecutor.exec — envelope events", () => {
  it("streams the raw events through in order", async () => {
    const f = fakeRpc({ events: [stdout(1, "a"), stdout(2, "b"), exit(3, 0)] });
    const execution = await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop");
    const { seen } = await drain(execution);
    expect(seen.map((e) => e.name)).toEqual(["stdout", "stdout", "exit"]);
  });

  it("carries stdout bytes untouched (no host-side encoding)", async () => {
    const f = fakeRpc({ events: [stdout(1, "hi"), exit(2, 0)] });
    const execution = await new CommandExecutor(f.rpc.shell, makeSync()).exec("noop");
    const { seen } = await drain(execution);
    const first = seen[0];
    expect(first.name).toBe("stdout");
    expect(first.value).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe("hi");
  });

  it("disposes the RPC envelope when the event stream errors", async () => {
    let disposed = 0;
    const shellRpc: ShellRPC = {
      async exec() {
        return {
          id: "broken",
          events: new ReadableStream<ExecEvent>({
            start(controller) {
              controller.error(new Error("transport failed"));
            },
          }),
          [Symbol.dispose]() {
            disposed += 1;
          },
        };
      },
      async getExec() {
        throw new Error("unused");
      },
      async killExec() {},
      async disposeExec() {},
    };
    const execution = await new CommandExecutor(shellRpc, makeSync()).exec("noop");
    await expect(execution.events.getReader().read()).rejects.toThrow("transport failed");
    expect(disposed).toBe(1);
  });

  it("disposes the RPC envelope when the consumer cancels", async () => {
    let disposed = 0;
    const shellRpc: ShellRPC = {
      async exec() {
        return {
          id: "cancelled",
          events: new ReadableStream<ExecEvent>(),
          [Symbol.dispose]() {
            disposed += 1;
          },
        };
      },
      async getExec() {
        throw new Error("unused");
      },
      async killExec() {},
      async disposeExec() {},
    };
    const execution = await new CommandExecutor(shellRpc, makeSync()).exec("noop");
    await execution.events.cancel();
    expect(disposed).toBe(1);
  });
});

describe("CommandExecutor.exec — push/pull bracket", () => {
  it("reports pushed up front and the pull outcome after drain", async () => {
    const f = fakeRpc({ events: [stdout(1, "hi"), exit(2, 0)] });
    const sync: Sync = {
      async push() {
        return 5;
      },
      async pull() {
        return applied(7);
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).exec("noop");
    expect(execution.sync.pushed).toBe(5);
    const { outcome } = await drain(execution);
    expect(outcome).toEqual({
      applied: 7,
      skipped: [],
      sync: { status: "complete", applied: 7, skipped: [] },
    });
  });

  it("surfaces skipped read-only entries from the post-drain pull", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const skipped = [
      {
        path: "/workspace/r2/touched.txt",
        mountRoot: "/workspace/r2",
        op: "write" as const,
        reason: "read-only" as const,
      },
    ];
    const sync: Sync = {
      async push() {
        return 0;
      },
      async pull() {
        return { applied: 2, skipped };
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).exec("noop");
    const { outcome } = await drain(execution);
    expect(outcome).toEqual({
      applied: 2,
      skipped,
      sync: { status: "complete", applied: 2, skipped },
    });
  });

  it("calls push() before spawn and pull() after drain, in that order", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const order: string[] = [];
    const sync: Sync = {
      async push() {
        order.push("push");
        return 0;
      },
      async pull() {
        order.push("pull");
        return applied(0);
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).exec("noop");
    expect(order).toEqual(["push"]); // push fired before exec returned
    await drain(execution);
    expect(order).toEqual(["push", "pull"]); // pull fired after drain
  });

  it("fails before spawn when the pre-exec push throws", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const sync: Sync = {
      async push() {
        throw new Error("push offline");
      },
      async pull() {
        return applied(3);
      },
    };

    await expect(new CommandExecutor(f.rpc.shell, sync).exec("noop")).rejects.toThrow(
      "push offline",
    );
    expect(f.calls.exec).toHaveLength(0);
  });

  it("reports a pending sync after a Durable Object storage reset", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const reset = "Internal error in Durable Object storage write caused object to be reset.";
    const sync: Sync = {
      async push() {
        return 2;
      },
      async pull() {
        throw new Error(reset);
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).exec("noop");
    const { outcome } = await drain(execution);
    expect(outcome).toEqual({
      applied: 0,
      skipped: [],
      sync: { status: "pending", applied: 0, skipped: [], error: reset },
    });
  });

  it("bounds and redacts pending sync errors", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const secret = "super-secret-value";
    const sync: Sync = {
      async push() {
        return 0;
      },
      async pull() {
        throw new Error(`transport failed token=${secret} ${"x".repeat(700)}`);
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).exec("noop");
    const { outcome } = await drain(execution);
    const settled = outcome as { sync: { status: string; error: string } };
    expect(settled.sync.status).toBe("pending");
    expect(settled.sync.error.length).toBeLessThanOrEqual(512);
    expect(settled.sync.error).toContain("transport failed token=[REDACTED]");
    expect(settled.sync.error).not.toContain(secret);
  });
});

describe("CommandExecutor.kill / dispose", () => {
  it("kill(signal) forwards the signal to killExec", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).kill("kid", "SIGKILL");
    expect(f.calls.killExec).toEqual([{ id: "kid", signal: "SIGKILL" }]);
  });

  it("kill() with no signal forwards undefined (server defaults to SIGTERM)", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).kill("kid");
    expect(f.calls.killExec).toEqual([{ id: "kid", signal: undefined }]);
  });
});

describe("CommandExecutor.get — reattach", () => {
  it("forwards id to getExec", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).get("attach-id");
    expect(f.calls.getExec[0].id).toBe("attach-id");
  });

  it("maps resume: 'full' to after: undefined", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).get("id", { resume: "full" });
    expect(f.calls.getExec[0].after).toBeUndefined();
  });

  it("maps resume: 'tail' to after: 'tail'", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).get("id", { resume: "tail" });
    expect(f.calls.getExec[0].after).toBe("tail");
  });

  it("maps resume: <number> to after: <number>", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).get("id", { resume: 17 });
    expect(f.calls.getExec[0].after).toBe(17);
  });

  it("omits after when resume is not supplied", async () => {
    const f = fakeRpc();
    await new CommandExecutor(f.rpc.shell, makeSync()).get("id");
    expect(f.calls.getExec[0].after).toBeUndefined();
  });

  it("returns an envelope whose id matches the requested id", async () => {
    const f = fakeRpc();
    const execution = await new CommandExecutor(f.rpc.shell, makeSync()).get("replay-me");
    expect(execution.id).toBe("replay-me");
  });

  it("skips the pre-exec push but still runs the post-drain pull", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    let pushCalls = 0;
    let pullCalls = 0;
    const sync: Sync = {
      async push() {
        pushCalls += 1;
        return 1;
      },
      async pull() {
        pullCalls += 1;
        return applied(2);
      },
    };
    const execution = await new CommandExecutor(f.rpc.shell, sync).get("x", { resume: "full" });
    expect(execution.sync.pushed).toBe(0);
    const { outcome } = await drain(execution);
    expect(pushCalls).toBe(0);
    expect(pullCalls).toBe(1);
    expect((outcome as { applied: number }).applied).toBe(2);
  });
});
