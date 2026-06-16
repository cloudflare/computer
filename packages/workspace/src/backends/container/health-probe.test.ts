import { describe, expect, test, vi } from "vitest";

import type { IWorkspaceContainerAPI } from "./container-host.js";
import { probeWsdHealth } from "./health-probe.js";

function fakeHost(
  handler: (port: number, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): IWorkspaceContainerAPI {
  return {
    start: vi.fn(async () => {}),
    interceptOutboundHttp: vi.fn(async () => {}),
    fetchPort: vi.fn(handler),
    port: vi.fn(() => {
      throw new Error("port() not used in these tests");
    }),
  } as unknown as IWorkspaceContainerAPI;
}

describe("probeWsdHealth", () => {
  test("resolves on a 2xx response", async () => {
    const host = fakeHost(async () => new Response(null, { status: 200 }));
    await expect(
      probeWsdHealth(host, { port: 8080, path: "/health", timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();
  });

  test("issues a HEAD request to the configured path", async () => {
    const calls: { port: number; url: string; method?: string }[] = [];
    const host = fakeHost(async (port, input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ port, url: req.url, method: req.method });
      return new Response(null, { status: 200 });
    });
    await probeWsdHealth(host, { port: 9090, path: "/__wsd/info", timeoutMs: 1_000 });
    expect(calls).toEqual([{ port: 9090, url: "http://container/__wsd/info", method: "HEAD" }]);
  });

  test("rejects on a non-2xx response with the status in the message", async () => {
    const host = fakeHost(async () => new Response("bad", { status: 503 }));
    await expect(
      probeWsdHealth(host, { port: 8080, path: "/health", timeoutMs: 1_000 }),
    ).rejects.toThrow(/503/);
  });

  test("propagates host.fetchPort rejections", async () => {
    const host = fakeHost(async () => {
      throw new Error("connection refused");
    });
    await expect(
      probeWsdHealth(host, { port: 8080, path: "/health", timeoutMs: 1_000 }),
    ).rejects.toThrow(/connection refused/);
  });

  test("aborts the request after timeoutMs", async () => {
    const host = fakeHost(async (_port, _input, init) => {
      // Simulate a never-responding wsd: wait until the AbortSignal
      // fires, then reject with an AbortError so the helper sees the
      // timeout surface as a rejection.
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return new Response(null, { status: 200 });
    });
    await expect(
      probeWsdHealth(host, { port: 8080, path: "/health", timeoutMs: 20 }),
    ).rejects.toThrow(/aborted|timeout/i);
  });
});
