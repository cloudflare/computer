// Unit tests for WorkspaceShell. The harness shell.test.ts under
// src/test-harness covers the wire end-to-end against a real computerd
// container; these tests run in-process with a fake WorkspaceRPC so
// the host-side facade (RPC forwarding, handle shape, encoding,
// result accumulation, push/pull bracket math) is exercised
// without needing Docker.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { describe, expect, it } from "vitest";

import type { KillSignal } from "./shell.js";
import { type Sync, WorkspaceShell } from "./shell.js";

// Inert sync impl. The shell unit tests aren't exercising the
// push/pull bracket — they just need a Sync that returns 0 from
// both methods so the bracket plumbing is a no-op. Workspace.test.ts
// covers the bracket against a real workspace.
//
// pull() returns the dofs ApplyResult shape ({ applied, skipped });
// tests that only care about counts use the `applied` helper below
// to build a synthetic result. Tests that want to exercise the
// skipped path build the shape inline.
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

// ---------------------------------------------------------------------------
// Test fixture: a fully synthesised WorkspaceRPC. Each helper method on the
// returned object also exposes the call log on the `calls` field so tests
// can assert on what the facade forwarded.
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
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
  // Events to push onto the stream returned by shell.exec / getExec.
  // The runner's id is stamped onto each event before enqueue.
  events?: ExecEvent[];
  // Optional: shell.exec rejects with this error.
  throwOnExec?: Error;
  // Optional: enqueue events, then error the stream with this.
  streamError?: Error;
  // Optional: id the runner mints when the caller doesn't supply one.
  // Defaults to "runner-minted-id".
  mintedId?: string;
}

function fakeRpc(options: FakeRpcOptions = {}): FakeRpc {
  const events = options.events ?? [{ id: "_", seq: 1, name: "exit", value: 0 }];
  const mintedId = options.mintedId ?? "runner-minted-id";
  const calls: FakeRpc["calls"] = {
    exec: [],
    getExec: [],
    killExec: [],
  };

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
        command: input.command,
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

// Convenience: a stream-event with the encoder bytes inlined.
function stdout(seq: number, text: string): ExecEvent {
  return { id: "_", seq, name: "stdout", value: new TextEncoder().encode(text) };
}
function stderr(seq: number, text: string): ExecEvent {
  return { id: "_", seq, name: "stderr", value: new TextEncoder().encode(text) };
}
function exit(seq: number, code: number): ExecEvent {
  return { id: "_", seq, name: "exit", value: code };
}

// ---------------------------------------------------------------------------
// exec() — RPC forwarding
// ---------------------------------------------------------------------------

describe("WorkspaceShell.exec — RPC forwarding", () => {
  it("forwards the command verbatim", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("echo hi && exit 0");
    expect(f.calls.exec).toHaveLength(1);
    expect(f.calls.exec[0].command).toBe("echo hi && exit 0");
  });

  it("forwards an explicit id", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop", { id: "stable-id" });
    expect(f.calls.exec[0].id).toBe("stable-id");
  });

  it("omits id from the RPC when the caller doesn't supply one", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop");
    expect(f.calls.exec[0].id).toBeUndefined();
  });

  it("forwards cwd", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop", { cwd: "/workspace/sub" });
    expect(f.calls.exec[0].cwd).toBe("/workspace/sub");
  });

  it("forwards timeoutMs", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop", { timeoutMs: 1000 });
    expect(f.calls.exec[0].timeoutMs).toBe(1000);
  });

  it("forwards timeoutMs: 0 to disable the timeout", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop", { timeoutMs: 0 });
    expect(f.calls.exec[0].timeoutMs).toBe(0);
  });

  it("leaves timeoutMs undefined when the caller omits it", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.exec("noop");
    expect(f.calls.exec[0].timeoutMs).toBeUndefined();
  });

  it("uses the id the runner returned, not the caller-supplied one", async () => {
    // The runner is authoritative — if it mints an id, the handle
    // exposes it. The facade doesn't second-guess.
    const f = fakeRpc({ mintedId: "from-runner" });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    expect(handle.id).toBe("from-runner");
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
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    await expect(shell.exec("noop")).rejects.toThrow("EEXEC_BUSY");
    expect(pushCalls).toBe(1);
    expect(pullCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// exec() — handle shape
// ---------------------------------------------------------------------------

describe("WorkspaceShell.exec — handle shape", () => {
  it("returns a ReadableStream that can be consumed with getReader()", async () => {
    const f = fakeRpc({ events: [stdout(1, "hi"), exit(2, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    expect(handle).toBeInstanceOf(ReadableStream);
    const reader = handle.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    reader.releaseLock();
  });

  it("returns a stream that supports for-await iteration", async () => {
    const f = fakeRpc({ events: [stdout(1, "a"), stdout(2, "b"), exit(3, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const seen: string[] = [];
    for await (const event of handle) seen.push(event.name);
    expect(seen).toEqual(["stdout", "stdout", "exit"]);
  });

  it("hides id / result / kill from Object.keys and JSON.stringify", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    expect(Object.keys(handle)).not.toContain("id");
    expect(Object.keys(handle)).not.toContain("result");
    expect(Object.keys(handle)).not.toContain("kill");
    // JSON.stringify on a stream returns "{}" (no enumerable own
    // properties), confirming the extras aren't traversed.
    expect(JSON.stringify(handle)).toBe("{}");
  });

  it("kill(signal) forwards the signal to killExec", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { id: "kid" });
    await handle.kill("SIGKILL");
    expect(f.calls.killExec).toEqual([{ id: "kid", signal: "SIGKILL" }]);
  });

  it("kill() with no signal forwards undefined (server defaults to SIGTERM)", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { id: "kid" });
    await handle.kill();
    expect(f.calls.killExec).toEqual([{ id: "kid", signal: undefined }]);
  });

  it("kill() resolves only after the exit event is observed on the wire", async () => {
    // Build a controllable stream where exit lands on demand. The
    // kill() promise must not resolve before exit shows up, even
    // though killExec returns immediately.
    let pushExit: ((code: number) => void) | undefined;
    const events: ReadableStream<ExecEvent> = new ReadableStream({
      start(c) {
        pushExit = (code) => {
          c.enqueue({ id: "kid", seq: 1, name: "exit", value: code });
          c.close();
        };
      },
    });
    let killReturned = 0;
    let killExecReturned = 0;
    let order = 0;
    const shellRpc: ShellRPC = {
      async exec(input) {
        return { id: input.id ?? "kid", events };
      },
      async getExec() {
        throw new Error("unused");
      },
      async killExec() {
        killExecReturned = ++order;
      },
      async disposeExec() {},
    };
    const shell = new WorkspaceShell(shellRpc, makeSync());
    const handle = await shell.exec("noop", { id: "kid" });
    const killPromise = handle.kill("SIGTERM").then(() => {
      killReturned = ++order;
    });
    // Give microtasks a chance to settle so killExec has returned.
    await new Promise((r) => setTimeout(r, 0));
    expect(killExecReturned).toBe(1);
    expect(killReturned).toBe(0); // not yet — exit hasn't arrived
    // Now deliver exit. kill() should resolve.
    pushExit?.(143);
    await killPromise;
    expect(killReturned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// exec() — result accumulation
// ---------------------------------------------------------------------------

describe("WorkspaceShell.exec — result accumulation", () => {
  it("concatenates stdout chunks in arrival order (Uint8Array default)", async () => {
    const f = fakeRpc({
      events: [stdout(1, "one"), stdout(2, "two"), stdout(3, "three"), exit(4, 0)],
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("onetwothree");
  });

  it("keeps stdout and stderr separate", async () => {
    const f = fakeRpc({
      events: [stdout(1, "out"), stderr(2, "err"), stdout(3, "out2"), exit(4, 0)],
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("outout2");
    expect(new TextDecoder().decode(result.stderr as Uint8Array)).toBe("err");
  });

  it("captures the exit code from the exit event", async () => {
    const f = fakeRpc({ events: [exit(1, 42)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.exitCode).toBe(42);
  });

  it("returns exitCode = -1 when the stream closes without an exit event", async () => {
    // The runner shouldn't do this, but if the wire drops mid-flight
    // the facade must still resolve so callers see something. -1 is
    // the documented sentinel.
    const f = fakeRpc({ events: [stdout(1, "partial")] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.exitCode).toBe(-1);
  });

  it("returns an empty Uint8Array when no output arrives", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect((result.stdout as Uint8Array).byteLength).toBe(0);
    expect((result.stderr as Uint8Array).byteLength).toBe(0);
  });

  it("returns an empty string for utf8 encoding with no output", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("rejects result() when the wire stream errors mid-flight", async () => {
    const f = fakeRpc({
      events: [stdout(1, "partial")],
      streamError: new Error("ESHUTDOWN"),
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop");
    await expect(handle.result()).rejects.toThrow("ESHUTDOWN");
  });
});

// ---------------------------------------------------------------------------
// exec() — utf8 encoding
// ---------------------------------------------------------------------------

describe("WorkspaceShell.exec — utf8 encoding", () => {
  it("returns stdout / stderr as strings when encoding is 'utf8'", async () => {
    const f = fakeRpc({
      events: [stdout(1, "hello "), stderr(2, "warn"), stdout(3, "world"), exit(4, 0)],
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
  });

  it("decodes multi-byte UTF-8 split across chunks correctly", async () => {
    // "🎉" is F0 9F 8E 89. Split mid-character: first three bytes,
    // then the trailing byte. A naive decoder per chunk produces
    // replacement characters; the streaming decoder must hold the
    // partial sequence and emit the full code point.
    const partyHat = new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]);
    const head = partyHat.subarray(0, 3);
    const tail = partyHat.subarray(3);
    const f = fakeRpc({
      events: [
        { id: "_", seq: 1, name: "stdout", value: head },
        { id: "_", seq: 2, name: "stdout", value: tail },
        exit(3, 0),
      ],
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.stdout).toBe("🎉");
  });

  it("keeps the stdout and stderr decoders independent", async () => {
    // Interleave a partial code point on each stream. If the
    // decoders share state, one stream's tail would land on the
    // other's head and corrupt both.
    const partyHat = new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]); // 🎉
    const heart = new Uint8Array([0xe2, 0x9d, 0xa4]); // ❤
    const f = fakeRpc({
      events: [
        { id: "_", seq: 1, name: "stdout", value: partyHat.subarray(0, 2) },
        { id: "_", seq: 2, name: "stderr", value: heart.subarray(0, 2) },
        { id: "_", seq: 3, name: "stdout", value: partyHat.subarray(2) },
        { id: "_", seq: 4, name: "stderr", value: heart.subarray(2) },
        exit(5, 0),
      ],
    });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.stdout).toBe("🎉");
    expect(result.stderr).toBe("❤");
  });

  it("preserves encoding when consuming the stream directly", async () => {
    const f = fakeRpc({ events: [stdout(1, "stream-mode"), exit(2, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const seen: unknown[] = [];
    for await (const event of handle) {
      if (event.name === "stdout") seen.push(event.value);
    }
    expect(seen).toEqual(["stream-mode"]);
  });
});

// ---------------------------------------------------------------------------
// exec() — push/pull bracket math
// ---------------------------------------------------------------------------

describe("WorkspaceShell.exec — push/pull bracket", () => {
  it("reports pushed and pulled from the Sync calls", async () => {
    const f = fakeRpc({ events: [stdout(1, "hi"), exit(2, 0)] });
    const sync: Sync = {
      async push() {
        return 5;
      },
      async pull() {
        return applied(7);
      },
    };
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.pushed).toBe(5);
    expect(result.pulled).toBe(7);
    expect(result.skipped).toEqual([]);
    expect(result.sync).toEqual({ status: "complete", applied: 7, skipped: [] });
  });

  it("reports a clean no-op pull as complete", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const result = await (await shell.exec("true")).result();
    expect(result.sync).toEqual({ status: "complete", applied: 0, skipped: [] });
  });

  it("surfaces skipped read-only entries from the post-drain pull", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const sync: Sync = {
      async push() {
        return 0;
      },
      async pull() {
        return {
          applied: 2,
          skipped: [
            {
              path: "/workspace/r2/touched.txt",
              mountRoot: "/workspace/r2",
              op: "write",
              reason: "read-only",
            },
          ],
        };
      },
    };
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.pulled).toBe(2);
    expect(result.skipped).toEqual([
      {
        path: "/workspace/r2/touched.txt",
        mountRoot: "/workspace/r2",
        op: "write",
        reason: "read-only",
      },
    ]);
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
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop");
    expect(order).toEqual(["push"]); // push fired before exec returned
    await handle.result();
    expect(order).toEqual(["push", "pull"]); // pull fired after drain
  });

  it("falls back to pushed = 0 when sync.push() throws", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const sync: Sync = {
      async push() {
        throw new Error("push offline");
      },
      async pull() {
        return applied(3);
      },
    };
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(result.pushed).toBe(0);
    // pull still fires — docs/05 says one failed half doesn't abort the other
    expect(result.pulled).toBe(3);
  });

  it("reports a pending sync after a Durable Object storage reset", async () => {
    const f = fakeRpc({
      events: [stdout(1, "command output"), stderr(2, "command warning"), exit(3, 23)],
    });
    const reset = "Internal error in Durable Object storage write caused object to be reset.";
    const sync: Sync = {
      async push() {
        return 2;
      },
      async pull() {
        throw new Error(reset);
      },
    };
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop", { encoding: "utf8" });
    const result = await handle.result();
    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "command output",
      stderr: "command warning",
      pushed: 2,
      pulled: 0,
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
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const result = await (await shell.exec("noop")).result();
    expect(result.sync.status).toBe("pending");
    if (result.sync.status !== "pending") throw new Error("expected pending sync");
    expect(result.sync.error.length).toBeLessThanOrEqual(512);
    expect(result.sync.error).toContain("transport failed token=[REDACTED]");
    expect(result.sync.error).not.toContain(secret);
  });

  it("reports a pending sync after an ordinary transport error", async () => {
    const f = fakeRpc({ events: [exit(1, 0)] });
    const sync: Sync = {
      async push() {
        return 2;
      },
      async pull() {
        throw new Error("WebSocket closed before pull completed");
      },
    };
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.exec("noop");
    const result = await handle.result();
    expect(result.pushed).toBe(2);
    expect(result.pulled).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.sync).toEqual({
      status: "pending",
      applied: 0,
      skipped: [],
      error: "WebSocket closed before pull completed",
    });
  });
});

// ---------------------------------------------------------------------------
// get() — reattach
// ---------------------------------------------------------------------------

describe("WorkspaceShell.get — reattach", () => {
  it("forwards id to getExec", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.get("attach-id");
    expect(f.calls.getExec[0].id).toBe("attach-id");
  });

  it("maps resume: 'full' to after: undefined", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.get("id", { resume: "full" });
    expect(f.calls.getExec[0].after).toBeUndefined();
  });

  it("maps resume: 'tail' to after: 'tail'", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.get("id", { resume: "tail" });
    expect(f.calls.getExec[0].after).toBe("tail");
  });

  it("maps resume: <number> to after: <number>", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.get("id", { resume: 17 });
    expect(f.calls.getExec[0].after).toBe(17);
  });

  it("omits after when resume is not supplied", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    await shell.get("id");
    expect(f.calls.getExec[0].after).toBeUndefined();
  });

  it("returns a handle whose id matches the requested id", async () => {
    const f = fakeRpc();
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.get("replay-me");
    expect(handle.id).toBe("replay-me");
  });

  it("skips the pre-exec push but still runs the post-drain pull", async () => {
    // Reattach doesn't own the original push frame: pushed = 0.
    // The post-drain pull still fires — anything computerd produced
    // between reattach and drain lands locally.
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
    const shell = new WorkspaceShell(f.rpc.shell, sync);
    const handle = await shell.get("x", { resume: "full" });
    const result = await handle.result();
    expect(pushCalls).toBe(0);
    expect(pullCalls).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(2);
  });

  it("accumulates the replayed output the same way exec() does", async () => {
    const f = fakeRpc({ events: [stdout(1, "replay"), exit(2, 5)] });
    const shell = new WorkspaceShell(f.rpc.shell, makeSync());
    const handle = await shell.get("id", { encoding: "utf8" });
    const result = await handle.result();
    expect(result.stdout).toBe("replay");
    expect(result.exitCode).toBe(5);
  });

  it("reattaches to a live run once the first handle is dropped", async () => {
    // The runner allows one live subscriber per run, so dropping a
    // handle has to give up its subscription. The handle keeps a
    // second reader on the event stream to watch for the exit event
    // (kill() awaits it), and that reader has to go too — otherwise
    // the subscription outlives the handle and reattach is refused
    // for the rest of the run.
    const f = liveRpc();
    const shell = new WorkspaceShell(f.shell, makeSync());
    const started = await shell.exec("sleep 100", { id: "long-run" });
    await started.cancel();

    const again = await shell.get("long-run", { encoding: "utf8", resume: "tail" });
    f.emit(stdout(1, "still here\n"));
    f.emit(exit(2, 0));
    const result = await again.result();
    expect(result.stdout).toBe("still here\n");
  });
});

// A ShellRPC that models the runner's live subscriber bookkeeping: one
// subscriber per run, and the slot only frees when that subscriber
// cancels. Events are pushed by the test through emit(), so the run
// stays live for as long as the test wants it to.
function liveRpc(): {
  shell: ShellRPC;
  emit: (event: ExecEvent) => void;
} {
  let subscriber: ReadableStreamDefaultController<ExecEvent> | undefined;
  const subscribe = (id: string): ReadableStream<ExecEvent> => {
    if (subscriber !== undefined) {
      throw new Error(`EEXEC_BUSY: exec ${id} already has a live subscriber`);
    }
    return new ReadableStream<ExecEvent>({
      start(c) {
        subscriber = c;
      },
      cancel() {
        subscriber = undefined;
      },
    });
  };
  return {
    // The runner closes the subscriber's stream after the exit
    // event; result() drains until close.
    emit: (event) => {
      subscriber?.enqueue(event);
      if (event.name === "exit") subscriber?.close();
    },
    shell: {
      async exec(input) {
        const id = input.id ?? "runner-minted-id";
        return { id, events: subscribe(id) };
      },
      async getExec(input) {
        return { id: input.id, events: subscribe(input.id) };
      },
      async killExec() {},
      async disposeExec() {},
    },
  };
}
