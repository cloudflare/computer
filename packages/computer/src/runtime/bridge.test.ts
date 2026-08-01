import { describe, expect, it } from "vitest";

import { WorkspaceRuntimeBridge } from "./bridge.js";
import type { WorkspaceRuntimeCapability } from "./capability.js";

const encoder = new TextEncoder();
const args = JSON.stringify(["run", "value"]);

function bridge(limits: {
  maxCalls?: number;
  maxTotalRequestBytes?: number;
  maxTotalResponseBytes?: number;
}) {
  return new WorkspaceRuntimeBridge({} as WorkspaceRuntimeCapability, {
    ...limits,
    trustedModules: {
      "ws:test": {
        async call() {
          return "ok";
        },
      },
    },
  });
}

async function message(response: Promise<string>) {
  return (JSON.parse(await response) as { error?: { message?: string } }).error?.message;
}

describe("WorkspaceRuntimeBridge cumulative limits", () => {
  it("accepts the configured call count and rejects the next call", async () => {
    const target = bridge({ maxCalls: 2 });
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toContain(
      "exceeds 2 capability calls",
    );
  });

  it("accepts requests at the cumulative byte boundary and rejects the next request", async () => {
    const bytes = encoder.encode(args).byteLength;
    const target = bridge({ maxTotalRequestBytes: bytes * 2 });
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toContain(
      `requests exceed ${bytes * 2} bytes`,
    );
  });

  it("accepts responses at the cumulative byte boundary and rejects the next response", async () => {
    const sample = await bridge({}).call("trusted/ws:test.call", args);
    const bytes = encoder.encode(sample).byteLength;
    const target = bridge({ maxTotalResponseBytes: bytes * 2 });
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toBeUndefined();
    await expect(message(target.call("trusted/ws:test.call", args))).resolves.toContain(
      `responses exceed ${bytes * 2} bytes`,
    );
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
