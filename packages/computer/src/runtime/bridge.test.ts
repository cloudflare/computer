import { describe, expect, it } from "vitest";

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

  it("rejects a request over the payload limit by its UTF-8 size", async () => {
    await expect(
      message(echoBridge(256).call("host/ws:test.run", ["é".repeat(200)])),
    ).resolves.toContain("request exceeds 256 bytes");
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
