// CloudflareContainerBackend tests — exercise the lifecycle
// plumbing against an in-process fake IWorkspaceContainerAPI.
//
// The successful connect() path constructs a WebSocketPair, which
// is a workerd global not available under the vitest node runner.
// These tests cover the paths that bail before the upgrade (port
// never opens, /connect non-2xx, /ws upgrade timeout), the
// handleFetch input validation, and the factory + workspace-ref
// plumbing. The full happy-path round-trip is covered by the live
// example.

import { describe, expect, test, vi } from "vitest";

import { CloudflareContainerBackend } from "./cloudflare-container.js";
import type { IWorkspaceContainerAPI, WorkspaceRef } from "./container-host.js";

interface FakeHostOptions {
  healthy?: boolean;
  connectStatus?: number;
}

interface FakeHost {
  host: IWorkspaceContainerAPI;
  calls: { name: string; args: unknown[] }[];
  startEnv?: Record<string, string>;
  interceptedHost?: string;
  interceptedWorkspace?: WorkspaceRef;
}

function makeFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const healthy = opts.healthy ?? true;
  const connectStatus = opts.connectStatus ?? 200;
  const calls: { name: string; args: unknown[] }[] = [];
  const state: FakeHost = { calls } as FakeHost;

  state.host = {
    async start(env) {
      calls.push({ name: "start", args: [env] });
      state.startEnv = env;
    },
    async interceptOutboundHttp(host, ref) {
      calls.push({ name: "interceptOutboundHttp", args: [host, ref] });
      state.interceptedHost = host;
      state.interceptedWorkspace = ref;
    },
    async fetchPort(port, input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ name: "fetchPort", args: [port, url.pathname, request.method] });
      if (url.pathname === "/health") {
        if (!healthy) throw new Error("connection refused");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/connect") {
        if (connectStatus !== 200) {
          return new Response(`/connect ${connectStatus}`, { status: connectStatus });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected port path: ${url.pathname}`);
    },
    port() {
      throw new Error("cross-boundary Fetchers should not be used by CloudflareContainerBackend");
    },
  };
  return state;
}

const fakeWorkspace: WorkspaceRef = { binding: "TestDO", id: "abc123" };

describe("CloudflareContainerBackend", () => {
  test("connect() throws when the container port never opens", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/container port 8080 did not open/);

    const names = fake.calls.map((c) => c.name);
    expect(names).toContain("start");
    expect(names).toContain("interceptOutboundHttp");
    expect(fake.interceptedHost).toBe("workspace.internal");
    expect(fake.interceptedWorkspace).toEqual(fakeWorkspace);
  });

  test("egressHost option overrides the default", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      egressHost: "wsd.local",
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(fake.interceptedHost).toBe("wsd.local");
  });

  test("containerEnv option merges onto the start() env", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      containerEnv: { CUSTOM: "1", PORT: "9000" },
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(fake.startEnv?.CUSTOM).toBe("1");
    // Caller-supplied value wins over the default.
    expect(fake.startEnv?.PORT).toBe("9000");
    // Defaults still flow through.
    expect(fake.startEnv?.MOUNT_POINT).toBe("/workspace");
  });

  test("container factory is invoked per connect()", async () => {
    const fake = makeFakeHost({ healthy: false });
    const factory = vi.fn(() => ({ getWorkspaceContainer: () => fake.host }));
    const backend = new CloudflareContainerBackend({
      container: factory,
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    await expect(backend.connect()).rejects.toThrow();
    // Two failed dials → two factory invocations. The cached
    // handle only short-circuits on success.
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("async container factory is awaited", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: async () => {
        await Promise.resolve();
        return { getWorkspaceContainer: () => fake.host };
      },
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(fake.calls.map((c) => c.name)).toContain("start");
  });

  test("connect() throws when /connect returns non-2xx", async () => {
    const fake = makeFakeHost({ connectStatus: 502 });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/POST \/connect returned 502/);
  });

  test("connect() throws when the /ws upgrade never arrives", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
    });

    await expect(backend.connect()).rejects.toThrow(/\/ws upgrade did not arrive/);
  });

  test("handleFetch rejects non-/ws paths", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
    });
    const res = await backend.handleFetch(new Request("http://workspace.internal/other"));
    expect(res.status).toBe(404);
  });

  test("handleFetch rejects missing upgrade header", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
    });
    const res = await backend.handleFetch(new Request("http://workspace.internal/ws"));
    expect(res.status).toBe(426);
  });
});
