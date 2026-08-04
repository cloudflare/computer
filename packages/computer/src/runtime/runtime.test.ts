import { describe, expect, it, vi } from "vitest";

import { WorkspaceRuntime } from "./runtime.js";
import type {
  ModuleExecutionEnvelope,
  WorkspaceModuleBackendHandle,
  WorkspaceRuntimeEvent,
} from "./types.js";

function emptyEnvelope(id: string): ModuleExecutionEnvelope {
  return {
    id,
    events: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

function moduleHandleStub(): WorkspaceModuleBackendHandle {
  return {
    exec: vi.fn(async (input) => emptyEnvelope(input.id ?? "exec")),
    getExec: vi.fn(async (input) => emptyEnvelope(input.id)),
    killExec: vi.fn(async () => {}),
    disposeExec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function eventStream(events: WorkspaceRuntimeEvent[]): ReadableStream<WorkspaceRuntimeEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

// A backend whose exec replays a fixed event sequence. Drives the
// runtime's encoding transform and result drain — the work the host
// shell facade used to own before every backend shared one path.
function replayBackend(events: WorkspaceRuntimeEvent[]): WorkspaceModuleBackendHandle {
  return {
    exec: vi.fn(async (input) => ({ id: input.id ?? "exec", events: eventStream(events) })),
    getExec: vi.fn(async (input) => ({ id: input.id, events: eventStream(events) })),
    killExec: vi.fn(async () => {}),
    disposeExec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function runtimeFor(handle: WorkspaceModuleBackendHandle): WorkspaceRuntime {
  return new WorkspaceRuntime({
    callableBackendIds: new Set(),
    backendHandle: async () => handle,
    resolveBackendId: () => "backend",
  });
}

function stdout(seq: number, value: Uint8Array): WorkspaceRuntimeEvent {
  return { id: "e", seq, name: "stdout", value };
}
function stderr(seq: number, value: Uint8Array): WorkspaceRuntimeEvent {
  return { id: "e", seq, name: "stderr", value };
}
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("WorkspaceRuntime result accumulation", () => {
  it("concatenates stdout chunks in arrival order as raw bytes", async () => {
    const runtime = runtimeFor(
      replayBackend([
        stdout(1, bytes("one")),
        stdout(2, bytes("two")),
        stdout(3, bytes("three")),
        { id: "e", seq: 4, name: "exit", code: 0 },
      ]),
    );
    const result = await (await runtime.exec("noop")).result();
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("onetwothree");
  });

  it("keeps stdout and stderr separate", async () => {
    const runtime = runtimeFor(
      replayBackend([
        stdout(1, bytes("out")),
        stderr(2, bytes("err")),
        stdout(3, bytes("out2")),
        { id: "e", seq: 4, name: "exit", code: 0 },
      ]),
    );
    const result = await (await runtime.exec("noop")).result();
    expect(new TextDecoder().decode(result.stdout as Uint8Array)).toBe("outout2");
    expect(new TextDecoder().decode(result.stderr as Uint8Array)).toBe("err");
  });

  it("captures the exit code from the exit event", async () => {
    const runtime = runtimeFor(replayBackend([{ id: "e", seq: 1, name: "exit", code: 42 }]));
    const result = await (await runtime.exec("noop")).result();
    expect(result.exitCode).toBe(42);
  });

  it("maps signal exit codes to a cancelled status", async () => {
    for (const code of [129, 130, 137, 143]) {
      const runtime = runtimeFor(replayBackend([{ id: "e", seq: 1, name: "exit", code: code }]));
      const result = await (await runtime.exec("noop")).result();
      expect(result.status).toBe("cancelled");
      expect(result.exitCode).toBe(code);
    }
  });

  it("reports exit code -1 when the stream closes without an exit event", async () => {
    const runtime = runtimeFor(replayBackend([stdout(1, bytes("partial"))]));
    const result = await (await runtime.exec("noop")).result();
    expect(result.exitCode).toBe(-1);
    expect(result.status).toBe("failed");
  });
});

describe("WorkspaceRuntime utf8 encoding", () => {
  it("returns stdout / stderr as strings when encoding is 'utf8'", async () => {
    const runtime = runtimeFor(
      replayBackend([
        stdout(1, bytes("hello ")),
        stderr(2, bytes("warn")),
        stdout(3, bytes("world")),
        { id: "e", seq: 4, name: "exit", code: 0 },
      ]),
    );
    const result = await (await runtime.exec("noop", { encoding: "utf8" })).result();
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn");
  });

  it("decodes multi-byte UTF-8 split across chunks correctly", async () => {
    const partyHat = new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]);
    const runtime = runtimeFor(
      replayBackend([
        stdout(1, partyHat.subarray(0, 3)),
        stdout(2, partyHat.subarray(3)),
        { id: "e", seq: 3, name: "exit", code: 0 },
      ]),
    );
    const result = await (await runtime.exec("noop", { encoding: "utf8" })).result();
    expect(result.stdout).toBe("\u{1f389}");
  });

  it("keeps the stdout and stderr decoders independent", async () => {
    const partyHat = new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]);
    const heart = new Uint8Array([0xe2, 0x9d, 0xa4]);
    const runtime = runtimeFor(
      replayBackend([
        stdout(1, partyHat.subarray(0, 2)),
        stderr(2, heart.subarray(0, 2)),
        stdout(3, partyHat.subarray(2)),
        stderr(4, heart.subarray(2)),
        { id: "e", seq: 5, name: "exit", code: 0 },
      ]),
    );
    const result = await (await runtime.exec("noop", { encoding: "utf8" })).result();
    expect(result.stdout).toBe("\u{1f389}");
    expect(result.stderr).toBe("\u2764");
  });

  it("preserves encoding when consuming the stream directly", async () => {
    const runtime = runtimeFor(
      replayBackend([stdout(1, bytes("stream-mode")), { id: "e", seq: 2, name: "exit", code: 0 }]),
    );
    const handle = await runtime.exec("noop", { encoding: "utf8" });
    const seen: unknown[] = [];
    for await (const event of handle) {
      if (event.name === "stdout") seen.push(event.value);
    }
    expect(seen).toEqual(["stream-mode"]);
  });
});

describe("WorkspaceRuntime callable gate", () => {
  it("rejects structured input for a non-callable backend", async () => {
    const runtime = new WorkspaceRuntime({
      callableBackendIds: new Set(),
      backendHandle: async () => moduleHandleStub(),
      resolveBackendId: () => "worker-shell",
    });

    await expect(
      runtime.exec("echo hi", { backend: "worker-shell", input: { n: 1 } }),
    ).rejects.toThrow(/not callable/);
  });

  it("accepts structured input for a callable module backend", async () => {
    const handle = moduleHandleStub();
    const runtime = new WorkspaceRuntime({
      callableBackendIds: new Set(["worker-javascript"]),
      backendHandle: async () => handle,
      resolveBackendId: () => "worker-javascript",
    });

    await runtime.exec("export default (i) => i", {
      backend: "worker-javascript",
      input: { n: 1 },
    });

    expect(handle.exec).toHaveBeenCalledWith(expect.objectContaining({ input: { n: 1 } }));
  });
});
