// What start() does when it finds a container already running.
//
// The environment and the outbound-internet flag can only be set at
// launch, so adopting a container launched with different ones would
// silently discard what the caller asked for. These cover the three
// outcomes and, in particular, the case that motivated them: a warm
// pool that started the container itself and left no record.
import { describe, expect, test, vi } from "vitest";

import { WorkspaceContainerAPI } from "./container-host.js";
import type { ContainerLaunchSpec } from "./container-launch-record.js";

function fakeCtx(options: { running?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const starts: { enableInternet: boolean; env: Record<string, string> }[] = [];
  let destroys = 0;
  // monitor() has to settle when the container goes away: the destroy
  // path waits on the current generation's monitor before the caller
  // installs the next one.
  let exited: (() => void) | undefined;
  const container = {
    running: options.running ?? false,
    start(spec: { enableInternet: boolean; env: Record<string, string> }) {
      starts.push(spec);
      container.running = true;
    },
    async destroy() {
      destroys += 1;
      container.running = false;
      exited?.();
      exited = undefined;
    },
    async setInactivityTimeout() {},
    monitor: () =>
      new Promise<void>((resolve) => {
        exited = resolve;
      }),
    getTcpPort: () => ({}) as Fetcher,
  };
  const ctx = {
    container,
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return values.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        values.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return values.delete(key);
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
  return { ctx, container, starts, destroyCount: () => destroys, values };
}

const spec: ContainerLaunchSpec = {
  env: { PORT: "8080", MOUNT_POINT: "/workspace" },
  enableInternet: false,
};

describe("WorkspaceContainerAPI.start", () => {
  test("launches when nothing is running", async () => {
    const { ctx, starts } = fakeCtx();

    const info = await new WorkspaceContainerAPI(ctx).start(spec);

    expect(info.outcome).toBe("launched");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.enableInternet).toBe(false);
    expect(starts[0]?.env.RPC_CLIENT_SECRET).toMatch(/^[0-9a-f]{32}$/);
  });

  test("adopts a container it launched with the same spec", async () => {
    const { ctx, starts, destroyCount } = fakeCtx();
    const api = new WorkspaceContainerAPI(ctx);
    const first = await api.start(spec);

    const second = await api.start(spec);

    expect(second.outcome).toBe("adopted");
    expect(second.runtimeId).toBe(first.runtimeId);
    expect(second.clientSecret).toBe(first.clientSecret);
    expect(starts).toHaveLength(1);
    expect(destroyCount()).toBe(0);
  });

  test("relaunches a container started outside this API", async () => {
    // The warm-pool case. A container running with no launch record was
    // started by something that never injected the secret, so adopting
    // it would leave the daemon unauthenticated and any requested
    // environment unapplied.
    const { ctx, container, starts, destroyCount } = fakeCtx();
    container.running = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const info = await new WorkspaceContainerAPI(ctx).start(spec);

      expect(info.outcome).toBe("relaunched");
      expect(destroyCount()).toBe(1);
      expect(starts).toHaveLength(1);
      expect(starts[0]?.env.RPC_CLIENT_SECRET).toMatch(/^[0-9a-f]{32}$/);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("relaunches when the internet flag differs", async () => {
    // The egress case: a container launched with the internet enabled
    // must not serve a workspace that asked for it off.
    const { ctx, starts } = fakeCtx();
    const api = new WorkspaceContainerAPI(ctx);
    await api.start({ ...spec, enableInternet: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const info = await api.start({ ...spec, enableInternet: false });

      expect(info.outcome).toBe("relaunched");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.enableInternet).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("relaunches when the environment differs", async () => {
    const { ctx, starts } = fakeCtx();
    const api = new WorkspaceContainerAPI(ctx);
    await api.start(spec);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const info = await api.start({
        ...spec,
        env: { ...spec.env, FUSE_MOUNT: "none" },
      });

      expect(info.outcome).toBe("relaunched");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.env.FUSE_MOUNT).toBe("none");
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps the same secret across a relaunch", async () => {
    // The secret is durable, so a replacement container is launched with
    // the value the host already holds.
    const { ctx } = fakeCtx();
    const api = new WorkspaceContainerAPI(ctx);
    const first = await api.start(spec);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const second = await api.start({ ...spec, enableInternet: true });

      expect(second.clientSecret).toBe(first.clientSecret);
    } finally {
      warn.mockRestore();
    }
  });
});
