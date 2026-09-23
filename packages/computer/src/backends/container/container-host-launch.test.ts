// What reaches ctx.container.start(), and what happens when the image
// cannot be resolved.
//
// Under this scheduling policy the durable object owns the container
// lifecycle, so start() has to name the image and may name a size.
// Both come from the launch spec, and both have to survive the trip
// through the host: a dropped field is not an error anywhere, it is a
// container that boots with the wrong filesystem or the wrong
// resources.
import { describe, expect, test } from "vitest";

import { WorkspaceContainerAPI } from "./container-host.js";
import type { ContainerLaunchSpec } from "./container-launch-record.js";

type StartOptions = ContainerStartupOptions;

function fakeCtx(options: { images?: Record<string, string>; running?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const starts: StartOptions[] = [];
  let exited: (() => void) | undefined;
  const container = {
    running: options.running ?? false,
    images: options.images ?? { app: "registry.example/app@sha256:abc" },
    start(spec: StartOptions) {
      starts.push(spec);
      container.running = true;
    },
    async destroy() {
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
  return { ctx, container, starts };
}

function spec(overrides: Partial<ContainerLaunchSpec> = {}): ContainerLaunchSpec {
  return {
    env: { PORT: "8080", MOUNT_POINT: "/workspace" },
    enableInternet: false,
    ...overrides,
  };
}

describe("launch options reach the platform", () => {
  test("resolves the default image when the spec names none", async () => {
    const { ctx, starts } = fakeCtx();

    await new WorkspaceContainerAPI(ctx).start(spec());

    expect(starts[0]).toMatchObject({ image: "registry.example/app@sha256:abc" });
  });

  test("resolves the named image", async () => {
    const { ctx, starts } = fakeCtx({
      images: { app: "img-app", toolchain: "img-toolchain" },
    });

    await new WorkspaceContainerAPI(ctx).start(spec({ name: "toolchain" }));

    expect(starts[0]).toMatchObject({ image: "img-toolchain" });
  });

  test("forwards the instance size", async () => {
    const { ctx, starts } = fakeCtx();
    const instance = { vcpu: 16, memoryMib: 32768, diskMb: 64000 };

    await new WorkspaceContainerAPI(ctx).start(spec({ instance }));

    expect(starts[0]?.instance).toEqual(instance);
  });

  test("forwards options the host does not itself interpret", async () => {
    const { ctx, starts } = fakeCtx();

    await new WorkspaceContainerAPI(ctx).start(
      spec({ entrypoint: ["/bin/sh", "-c", "computerd"], labels: { tier: "gold" } }),
    );

    expect(starts[0]?.entrypoint).toEqual(["/bin/sh", "-c", "computerd"]);
    expect(starts[0]?.labels).toEqual({ tier: "gold" });
  });

  test("injects the client secret over a caller-supplied value", async () => {
    const { ctx, starts } = fakeCtx();

    await new WorkspaceContainerAPI(ctx).start(
      spec({ env: { PORT: "8080", RPC_CLIENT_SECRET: "attacker-chosen" } }),
    );

    expect(starts[0]?.env?.RPC_CLIENT_SECRET).toMatch(/^[0-9a-f]{32}$/);
    expect(starts[0]?.env?.RPC_CLIENT_SECRET).not.toBe("attacker-chosen");
  });

  test("boots from a snapshot instead of an image when one is given", async () => {
    const { ctx, starts } = fakeCtx();

    await new WorkspaceContainerAPI(ctx).start(spec({ containerSnapshot: { id: "snap-1" } }));

    expect(starts[0]).toMatchObject({ containerSnapshot: { id: "snap-1" } });
    expect(starts[0]).not.toHaveProperty("image");
  });
});

describe("image resolution failures", () => {
  // The likeliest first-run mistake: pointing this backend at a
  // container the platform schedules. No image name could resolve, so
  // the message has to name the backend that serves that deployment
  // rather than just reporting an empty map.
  test("an empty images map names the backend that serves that deployment", async () => {
    const { ctx } = fakeCtx({ images: {} });

    await expect(new WorkspaceContainerAPI(ctx).start(spec())).rejects.toThrow(
      /LegacyContainerBackend/,
    );
  });

  test("an empty images map explains the wrangler configuration it expects", async () => {
    const { ctx } = fakeCtx({ images: {} });

    await expect(new WorkspaceContainerAPI(ctx).start(spec())).rejects.toThrow(/scheduling_policy/);
  });

  test("an unknown image name lists the prepared images", async () => {
    const { ctx } = fakeCtx({ images: { app: "img-app", toolchain: "img-toolchain" } });

    await expect(new WorkspaceContainerAPI(ctx).start(spec({ name: "missing" }))).rejects.toThrow(
      /prepared images: app, toolchain/,
    );
  });

  // A failed resolve must not leave a runtime identity claiming a
  // process that was never started, or a later call addresses a
  // container that does not exist.
  test("a failed launch clears the runtime identity", async () => {
    const { ctx, starts } = fakeCtx({ images: {} });
    const api = new WorkspaceContainerAPI(ctx);

    await expect(api.start(spec())).rejects.toThrow();

    expect(starts).toHaveLength(0);
    expect(await api.status()).toMatchObject({ running: false });
  });
});
