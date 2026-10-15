import { describe, expect, it, vi } from "vitest";

import { type BridgeJournal, type BridgeResponse, WorkspaceRuntimeBridge } from "./bridge.js";
import type { WorkspaceRuntimeCapability } from "./capability.js";
import { unsafeToRepeat } from "./replay-safety.js";
import type { WorkspaceModuleCallContext } from "./types.js";

const encoder = new TextEncoder();
const args = ["value"];

function bridge(limits: {
  maxCalls?: number;
  maxTotalRequestBytes?: number;
  maxTotalResponseBytes?: number;
}) {
  return new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
    ...limits,
    hostModules: new Map([["ws:test", { run: async () => "ok" }]]),
  });
}

async function message(response: Promise<BridgeResponse>) {
  const settled = await response;
  return "error" in settled ? settled.error.message : undefined;
}

describe("WorkspaceRuntimeBridge cumulative limits", () => {
  it("accepts the configured call count and rejects the next call", async () => {
    const target = bridge({ maxCalls: 2 });
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toContain(
      "exceeds 2 capability calls",
    );
  });

  it("accepts requests at the cumulative byte boundary and rejects the next request", async () => {
    // ["value"]: 8 for the array plus 5 UTF-8 bytes for the string.
    const bytes = 8 + encoder.encode("value").byteLength;
    const target = bridge({ maxTotalRequestBytes: bytes * 2 });
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toContain(
      `requests exceed ${bytes * 2} bytes`,
    );
  });

  it("accepts responses at the cumulative byte boundary and rejects the next response", async () => {
    // The host function returns "ok": 2 UTF-8 bytes.
    const bytes = encoder.encode("ok").byteLength;
    const target = bridge({ maxTotalResponseBytes: bytes * 2 });
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toContain(
      `responses exceed ${bytes * 2} bytes`,
    );
  });

  it("counts error responses against the cumulative response budget", async () => {
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxTotalResponseBytes: 256,
      hostModules: new Map([
        [
          "ws:test",
          {
            fail: async () => {
              throw new Error("x".repeat(100));
            },
          },
        ],
      ]),
    });
    await expect(message(target.call("host/ws:test.fail", []))).resolves.toBe("x".repeat(100));
    await expect(message(target.call("host/ws:test.fail", []))).resolves.toContain(
      "responses exceed 256 bytes",
    );
  });
});

describe("WorkspaceRuntimeBridge host modules", () => {
  function echo(values: unknown[]) {
    return new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      hostModules: new Map([
        [
          "ws:test",
          {
            run: async () => values[0],
            args: async (received) => received,
          },
        ],
      ]),
    });
  }

  it("leaves undefined fields out and turns undefined array items into null", async () => {
    await expect(
      echo([{ value: 1, optional: undefined, list: [1, undefined] }]).call("host/ws:test.run", []),
    ).resolves.toEqual({ result: { value: 1, list: [1, null] } });
    await expect(
      echo([]).call("host/ws:test.args", [undefined, { a: undefined, b: 2 }]),
    ).resolves.toEqual({ result: [null, { b: 2 }] });
  });

  it("calls a host function on its module", async () => {
    const functions = {
      async name() {
        return "ok";
      },
      async run(this: { name(): Promise<string> }) {
        return this.name();
      },
    };
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      hostModules: new Map([["ws:test", functions]]),
    });
    await expect(target.call("host/ws:test.run", [])).resolves.toEqual({ result: "ok" });
  });
});

describe("WorkspaceRuntimeBridge values", () => {
  function echoBridge(maxPayloadBytes?: number) {
    return new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
      hostModules: new Map([["ws:test", { run: async (values) => values[0] ?? null }]]),
    });
  }

  it("passes plain values through without encoding them", async () => {
    await expect(
      echoBridge().call("host/ws:test.run", [{ nested: [1, "two", null, { three: true }] }]),
    ).resolves.toEqual({ result: { nested: [1, "two", null, { three: true }] } });
  });

  it.each([
    ["a function", () => 1],
    ["a class instance", new Date(0)],
  ])("rejects %s in a request before it reaches the host", async (_label, value) => {
    await expect(message(echoBridge().call("host/ws:test.run", [value]))).resolves.toContain(
      "plain data",
    );
  });

  it("rejects a cyclic request", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(message(echoBridge().call("host/ws:test.run", [cyclic]))).resolves.toContain(
      "acyclic",
    );
  });

  it("rejects a request of many empty values by the payload limit", async () => {
    await expect(
      message(echoBridge(256).call("host/ws:test.run", [new Array(300).fill("")])),
    ).resolves.toContain("request exceeds 256 bytes");
    await expect(
      message(echoBridge(256).call("host/ws:test.run", [new Array(40).fill({})])),
    ).resolves.toContain("request exceeds 256 bytes");
  });

  it("keeps an own __proto__ field in a host module result", async () => {
    const value = JSON.parse('{"__proto__": {"a": 1}, "b": 2}') as unknown;
    const response = await echoBridge().call("host/ws:test.run", [value]);
    expect(Object.keys((response as { result: object }).result)).toEqual(["__proto__", "b"]);
  });

  it("keeps a path that fits beside a short error message", async () => {
    const path = `/${"p".repeat(600)}`;
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxPayloadBytes: 1024,
      hostModules: new Map([
        [
          "ws:test",
          {
            run: async () => {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path });
            },
          },
        ],
      ]),
    });
    await expect(target.call("host/ws:test.run", [])).resolves.toEqual({
      error: { message: "ENOENT", code: "ENOENT", path },
    });
  });

  it("keeps an error with a long path within the payload limit", async () => {
    const path = `/${"p".repeat(900)}`;
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxPayloadBytes: 1024,
      hostModules: new Map([
        [
          "ws:test",
          {
            run: async () => {
              throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
                code: "ENOENT",
                path,
              });
            },
          },
        ],
      ]),
    });
    const response = await target.call("host/ws:test.run", []);
    expect(response).toMatchObject({ error: { code: "ENOENT" } });
    expect(response).not.toHaveProperty("error.path");
    expect(encoder.encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(1024);
  });

  it("rejects a request over the payload limit by its UTF-8 size", async () => {
    await expect(
      message(echoBridge(256).call("host/ws:test.run", ["é".repeat(200)])),
    ).resolves.toContain("request exceeds 256 bytes");
  });

  it("measures a request without copying its strings", async () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(
        message(echoBridge(1024).call("host/ws:test.run", ["x".repeat(1024 * 1024)])),
      ).resolves.toContain("request exceeds 1024 bytes");
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
});

describe("WorkspaceRuntimeBridge assertResult", () => {
  function resultBridge(maxResultBytes?: number) {
    return new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, { maxResultBytes });
  }

  it("accepts a JSON-compatible value", async () => {
    await expect(
      resultBridge().assertResult({ a: [1, 2, null], b: "ok" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a value that is not JSON-compatible", async () => {
    await expect(resultBridge().assertResult(new Date())).rejects.toThrow(/plain objects/);
  });

  it("rejects a value that exceeds the result byte ceiling", async () => {
    await expect(resultBridge(8).assertResult("x".repeat(64))).rejects.toThrow(
      /result exceeds 8 bytes/,
    );
  });
});

describe("WorkspaceRuntimeBridge journal", () => {
  function journaled(steps: ReturnType<BridgeJournal["begin"]>[]) {
    const commits: number[] = [];
    const journal: BridgeJournal = {
      begin: () => steps.shift() ?? { kind: "live", seq: 99, rerun: false },
      commit: (seq) => {
        commits.push(seq);
        return { at: 1234, ordinal: 7 };
      },
      record: (position, events) => {
        if (!Array.isArray(events)) throw new Error("malformed event log");
        logs.push([position, events]);
      },
      diverged: (message) => diverged.push(message),
      stalled: () => diverged.push("stalled"),
    };
    const diverged: string[] = [];
    const logs: unknown[] = [];
    const contexts: WorkspaceModuleCallContext[] = [];
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxTotalResponseBytes: 4,
      hostModules: new Map([
        [
          "ws:test",
          {
            run: async (_args: unknown, context: WorkspaceModuleCallContext) => {
              contexts.push(context);
              return "ok";
            },
            charge: unsafeToRepeat(async () => "c"),
          },
        ],
      ]),
      journal,
      callIdPrefix: "exec-1",
    });
    return { target, commits, diverged, contexts, logs };
  }

  it("answers a replayed call from the journal and journals a live one", async () => {
    const { target, commits } = journaled([
      { kind: "replay", response: { result: "no" }, at: 5, ordinal: 1 },
      { kind: "live", seq: 2, rerun: false },
    ]);
    await expect(target.call("host/ws:test.run", args)).resolves.toEqual({
      result: "no",
      at: 5,
      ordinal: 1,
    });
    await expect(target.call("host/ws:test.run", args)).resolves.toEqual({
      result: "ok",
      at: 1234,
      ordinal: 7,
    });
    expect(commits).toEqual([2]);
  });

  it("saves the event log a call carries before making the call", async () => {
    const { target, logs } = journaled([{ kind: "live", seq: 1, rerun: false }]);
    await target.call("host/ws:test.run", args, { from: 3, events: [4, -1] });
    expect(logs).toEqual([[3, [4, -1]]]);
    await expect(
      message(target.call("host/ws:test.run", args, { from: 5, events: "x" as never })),
    ).resolves.toContain("malformed event log");
  });

  it("gives a journaled call the same id when it runs again", async () => {
    const { target, contexts } = journaled([
      { kind: "live", seq: 7, rerun: false },
      { kind: "live", seq: 7, rerun: true },
    ]);
    await target.call("host/ws:test.run", args);
    await target.call("host/ws:test.run", args);
    expect(contexts.map((context) => context.callId)).toEqual(["exec-1:7", "exec-1:7"]);
  });

  it("refuses to run an unsafe call again after an interruption", async () => {
    const { target, diverged } = journaled([
      { kind: "live", seq: 1, rerun: false },
      { kind: "live", seq: 1, rerun: true },
      { kind: "live", seq: 2, rerun: true },
    ]);
    await expect(target.call("host/ws:test.charge", args)).resolves.toMatchObject({
      result: "c",
    });
    await expect(message(target.call("host/ws:test.charge", args))).resolves.toContain(
      "interrupted while ws:test.charge was running, which isn't safe to repeat",
    );
    expect(diverged).toHaveLength(1);
    // A function that isn't marked runs again.
    await expect(target.call("host/ws:test.run", args)).resolves.toMatchObject({ result: "ok" });
  });

  it("saves an event log sent on its own", () => {
    const { target, logs } = journaled([]);
    target.recordLog({ from: 0, events: [-1, -2] });
    expect(logs).toEqual([[0, [-1, -2]]]);
  });

  it("passes a stalled replay to the journal", () => {
    const { target, diverged } = journaled([]);
    target.reportStall();
    expect(diverged).toEqual(["stalled"]);
  });

  it("counts replayed responses against the cumulative response budget", async () => {
    const { target } = journaled([
      { kind: "replay", response: { result: "abc" }, at: 5 },
      { kind: "live", seq: 2 },
    ]);
    await target.call("host/ws:test.run", args);
    await expect(message(target.call("host/ws:test.run", args))).resolves.toContain(
      "responses exceed 4 bytes",
    );
  });

  it("doesn't count a replayed budget error, as the first attempt didn't", async () => {
    const { target } = journaled([
      {
        kind: "replay",
        response: {
          error: { message: "Workspace execution capability responses exceed 4 bytes." },
        },
        at: 5,
      },
      { kind: "live", seq: 2, rerun: false },
    ]);
    await target.call("host/ws:test.run", args);
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
  });
});

describe("WorkspaceRuntimeBridge fetch", () => {
  it("keeps fetch out of the capability call budgets", async () => {
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxCalls: 1,
      maxTotalResponseBytes: 8,
      hostModules: new Map([["ws:test", { run: async () => "ok" }]]),
      fetch: async () => new Response("a response well over eight bytes"),
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(message(target.call("net.fetch", [request]))).resolves.toBeUndefined();
    }
    await expect(message(target.call("host/ws:test.run", args))).resolves.toBeUndefined();
    await expect(message(target.call("host/ws:test.run", args))).resolves.toContain(
      "exceeds 1 capability calls",
    );
  });

  it("queues fetches past six open at once instead of refusing them", async () => {
    let open = 0;
    let peak = 0;
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxConcurrentCalls: 2,
      fetch: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return new Response("ok");
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => message(target.call("net.fetch", [request]))),
    );
    expect(responses).toEqual(Array.from({ length: 10 }, () => undefined));
    expect(peak).toBe(6);
  });

  const request = {
    url: "https://example.test/a",
    method: "POST",
    redirect: "manual",
    headers: [["x-a", "1"]],
    body: encoder.encode("hi"),
  };

  it("makes the request through the host and buffers the response", async () => {
    const seen: Request[] = [];
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      fetch: async (incoming) => {
        seen.push(incoming);
        return new Response("pong", { status: 201, headers: { "x-b": "2" } });
      },
    });
    const response = await target.call("net.fetch", [request]);
    expect(response).toMatchObject({
      result: { status: 201, headers: expect.arrayContaining([["x-b", "2"]]) },
    });
    const result = "result" in response ? (response.result as { body: Uint8Array }) : undefined;
    expect(new TextDecoder().decode(result?.body)).toBe("pong");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.headers.get("x-a")).toBe("1");
    expect(await seen[0]?.text()).toBe("hi");
  });

  it("refuses when the isolate has no network access", async () => {
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {});
    await expect(message(target.call("net.fetch", [request]))).resolves.toContain(
      "no network access",
    );
  });

  it("refuses a response body over the payload limit", async () => {
    const target = new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
      maxPayloadBytes: 256,
      fetch: async () => new Response("x".repeat(1024)),
    });
    await expect(message(target.call("net.fetch", [request]))).resolves.toContain(
      "exceeds 256 bytes",
    );
  });
});
