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

import { WorkspaceTransportError } from "../../transport-failure.js";
import { CloudflareContainerBackend } from "./cloudflare-container.js";
import type { IWorkspaceContainerAPI, WorkspaceRef } from "./container-host.js";

interface FakeHostOptions {
  healthy?: boolean;
  // Health probe sequence: each connect() reads from the head of
  // this array. true = answer 200, false = throw "connection
  // refused". A single `healthy` flag still works for tests that
  // don't care about transitions.
  healthSequence?: boolean[];
  connectStatus?: number;
  start?: () => Promise<void>;
  restart?: () => Promise<void>;
  // Pre-set a prior exit reason so connect()'s pre-flight
  // exitInfo() check observes it.
  priorExit?: { exitedAt: number; reason: string } | null;
}

interface FakeHost {
  host: IWorkspaceContainerAPI;
  calls: { name: string; args: unknown[] }[];
  startEnv?: Record<string, string>;
  enableInternet?: boolean;
  interceptedHost?: string;
  interceptedWorkspace?: WorkspaceRef;
  gatewayWorkspace?: WorkspaceRef;
  gatewayToken?: string;
  running: boolean;
  exit: { exitedAt: number; reason: string } | null;
  simulateExit(reason: string): void;
}

function makeFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const healthSequence = opts.healthSequence?.slice();
  const defaultHealthy = opts.healthy ?? true;
  const connectStatus = opts.connectStatus ?? 200;
  const calls: { name: string; args: unknown[] }[] = [];
  const state: FakeHost = {
    calls,
    running: false,
    exit: opts.priorExit ?? null,
    simulateExit(reason: string) {
      state.exit = { exitedAt: Date.now(), reason };
      state.running = false;
    },
  } as FakeHost;

  function nextHealthy(): boolean {
    if (healthSequence && healthSequence.length > 0) {
      return healthSequence.shift() ?? defaultHealthy;
    }
    return defaultHealthy;
  }

  state.host = {
    async start(env, enableInternet) {
      calls.push({ name: "start", args: [env, enableInternet] });
      state.startEnv = env;
      state.enableInternet = enableInternet;
      await opts.start?.();
      state.running = true;
      // A successful start clears any prior exit, matching
      // WorkspaceContainerAPI.start.
      state.exit = null;
    },
    async interceptOutboundHttp(host, ref) {
      calls.push({ name: "interceptOutboundHttp", args: [host, ref] });
      state.interceptedHost = host;
      state.interceptedWorkspace = ref;
    },
    async interceptAllOutboundHttp(ref, token) {
      calls.push({ name: "interceptAllOutboundHttp", args: [ref, token] });
      state.gatewayWorkspace = ref;
      state.gatewayToken = token;
    },
    async fetchPort(port, input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ name: "fetchPort", args: [port, url.pathname, request.method] });
      if (url.pathname === "/health") {
        if (!nextHealthy()) throw new Error("connection refused");
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
    async restart(env, enableInternet) {
      calls.push({ name: "restart", args: [env, enableInternet] });
      if (opts.restart) {
        await opts.restart();
      }
      state.running = true;
      state.exit = null;
    },
    async status() {
      calls.push({ name: "status", args: [] });
      return { running: state.running, exit: state.exit };
    },
    async exitInfo() {
      calls.push({ name: "exitInfo", args: [] });
      return state.exit;
    },
  } satisfies IWorkspaceContainerAPI;
  return state;
}

const fakeWorkspace: WorkspaceRef = { binding: "TestDO", id: "abc123" };

describe("CloudflareContainerBackend", () => {
  test("connect() classifies a container start failure as transport", async () => {
    const platformError = new Error(
      "There is no container instance that can be provided to this Durable Object, try again later",
    );
    const fake = makeFakeHost({
      start: async () => {
        throw platformError;
      },
    });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
    });

    const error = await backend.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceTransportError);
    expect(error).toMatchObject({ cause: platformError });
    expect(String(error)).toMatch(/stage=start/);
  });

  test("connect() throws when the container port never opens", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
      restartAttempts: 0,
    });

    const error = await backend.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceTransportError);
    expect(error).toMatchObject({ cause: expect.any(Error) });
    expect(String(error)).toMatch(/stage=health.*port=8080/);

    const names = fake.calls.map((c) => c.name);
    expect(names).toContain("start");
    expect(names).toContain("interceptOutboundHttp");
    expect(fake.interceptedHost).toBe("computer.internal");
    expect(fake.interceptedWorkspace).toEqual(fakeWorkspace);
  });

  test("blocks ambient egress by default", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
    });

    await expect(backend.connect()).rejects.toThrow();

    expect(fake.enableInternet).toBe(false);
  });

  test("enables direct ambient egress", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
      egress: { mode: "direct" },
    });

    await expect(backend.connect()).rejects.toThrow();

    expect(fake.enableInternet).toBe(true);
  });

  test("restores tokenized egress callbacks before calling the gateway", async () => {
    const fake = makeFakeHost({ healthy: false });
    let gatewayRequest: Request | undefined;
    const gateway = {
      fetch: vi.fn(async (request: Request) => {
        gatewayRequest = request;
        return new Response(request.url);
      }),
    } as unknown as Fetcher;
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
      egress: { mode: "http-gateway", gateway },
    });
    await expect(backend.connect()).rejects.toThrow();
    const request = new Request("https://workspace.internal/ws", {
      method: "POST",
      body: "payload",
      headers: {
        "x-workspace-egress-token": fake.gatewayToken ?? "",
        "x-workspace-egress-url": "https://api.example.test/data?format=json",
      },
    });

    const response = await backend.handleFetch(request);

    expect(fake.gatewayWorkspace).toEqual(fakeWorkspace);
    expect(await response.text()).toBe("https://api.example.test/data?format=json");
    expect(gatewayRequest?.method).toBe("POST");
    expect(await gatewayRequest?.text()).toBe("payload");
    expect(gatewayRequest?.headers.get("x-workspace-egress-token")).toBeNull();
    expect(gatewayRequest?.headers.get("x-workspace-egress-url")).toBeNull();
    expect(gateway.fetch).toHaveBeenCalledOnce();
  });

  test("rejects tokenized egress callbacks without a valid original URL", async () => {
    const fake = makeFakeHost({ healthy: false });
    const gateway = {
      fetch: vi.fn(async () => new Response("forwarded")),
    } as unknown as Fetcher;
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
      egress: { mode: "http-gateway", gateway },
    });
    await expect(backend.connect()).rejects.toThrow();

    const response = await backend.handleFetch(
      new Request("https://workspace.internal/ws", {
        headers: {
          "x-workspace-egress-token": fake.gatewayToken ?? "",
          "x-workspace-egress-url": "ftp://api.example.test/data",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(gateway.fetch).not.toHaveBeenCalled();
  });

  test("rejects container egress callbacks with the wrong token", async () => {
    const fake = makeFakeHost({ healthy: false });
    const gateway = {
      fetch: vi.fn(async () => new Response("forwarded")),
    } as unknown as Fetcher;
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 300,
      egress: { mode: "http-gateway", gateway },
    });
    await expect(backend.connect()).rejects.toThrow();

    const response = await backend.handleFetch(
      new Request("https://api.example.test/data", {
        headers: { "x-workspace-egress-token": "wrong" },
      }),
    );

    expect(response.status).toBe(404);
    expect(gateway.fetch).not.toHaveBeenCalled();
  });

  test("egressHost option overrides the default", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      egressHost: "computerd.local",
      connectTimeoutMs: 300,
    });
    await expect(backend.connect()).rejects.toThrow();
    expect(fake.interceptedHost).toBe("computerd.local");
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

    const error = await backend.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceTransportError);
    expect(String(error)).toMatch(/POST \/connect returned 502/);
  });

  test("connect() throws a transport error when the /ws upgrade never arrives", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
    });

    const error = await backend.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceTransportError);
    expect(String(error)).toMatch(/\/ws upgrade did not arrive/);
  });

  test("handleFetch rejects non-/ws paths", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
    });
    const res = await backend.handleFetch(new Request("http://computer.internal/other"));
    expect(res.status).toBe(404);
  });

  test("handleFetch rejects missing upgrade header", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
    });
    const res = await backend.handleFetch(new Request("http://computer.internal/ws"));
    expect(res.status).toBe(426);
  });

  test("connect() consults host.exitInfo() before host.start()", async () => {
    const fake = makeFakeHost();
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
      restartAttempts: 0,
    });
    // Doesn't matter that this rejects — we just want to observe
    // the call order.
    await backend.connect().catch(() => undefined);
    const names = fake.calls.map((c) => c.name);
    const exitIdx = names.indexOf("exitInfo");
    const startIdx = names.indexOf("start");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeLessThan(startIdx);
  });

  test("connect() surfaces a prior exit reason in the stage-tagged error", async () => {
    const fake = makeFakeHost({
      healthy: false,
      priorExit: { exitedAt: Date.now() - 5_000, reason: "OOM killed" },
    });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
      restartAttempts: 0,
    });
    const err = await backend.connect().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/stage=health/);
    expect(String(err)).toMatch(/priorExit="OOM killed"/);
  });

  test("connect() restarts the host when initial readiness fails and recovers", async () => {
    // First attempt drains all probes as failures; restart() runs;
    // the second attempt's very first probe answers healthy.
    // connect() still fails at the /ws upgrade (no WebSocketPair
    // under node) — the point is that readiness recovered after
    // restart and we reached the /connect POST and /ws upgrade.
    const fake = makeFakeHost({
      healthSequence: [
        // First attempt — enough failures to exhaust the budget.
        false,
        false,
        false,
        false,
        false,
        // Restart, then second attempt: first probe is healthy.
        true,
      ],
    });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 2000,
      restartAttempts: 1,
    });
    await expect(backend.connect()).rejects.toThrow(/stage=ws/);
    const names = fake.calls.map((c) => c.name);
    expect(names.filter((n) => n === "start")).toHaveLength(1);
    expect(names.filter((n) => n === "restart")).toHaveLength(1);
    // /connect was reached after restart succeeded.
    const paths = fake.calls.filter((c) => c.name === "fetchPort").map((c) => c.args[1] as string);
    expect(paths).toContain("/connect");
  });

  test("connect() surfaces stage='health' when readiness exhausts all attempts", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 800,
      restartAttempts: 1,
    });
    const err = await backend.connect().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    const msg = String(err);
    expect(msg).toMatch(/stage=health/);
    expect(msg).toMatch(/attempts?=2/);
    expect(msg).toMatch(/port=8080/);
    // restart was attempted before giving up.
    expect(fake.calls.some((c) => c.name === "restart")).toBe(true);
  });

  test("connect() reports stage='health' when restartAttempts=0 and probe never succeeds", async () => {
    const fake = makeFakeHost({ healthy: false });
    const backend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: fakeWorkspace,
      connectTimeoutMs: 600,
      restartAttempts: 0,
    });
    const err = await backend.connect().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/stage=health/);
    // No restart attempt.
    expect(fake.calls.some((c) => c.name === "restart")).toBe(false);
  });
});
