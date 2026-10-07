import { describe, expect, it, vi } from "vitest";

import { type BridgeResponse, WorkspaceRuntimeBridge } from "./bridge.js";
import type { WorkspaceRuntimeCapability } from "./capability.js";

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
