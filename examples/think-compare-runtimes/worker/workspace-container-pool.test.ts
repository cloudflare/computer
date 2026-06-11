import { describe, expect, test, vi } from "vitest";
import type { WorkspaceContainerHost } from "./workspace-container-pool";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
}));

describe("createWorkspaceWarmPoolRuntime", () => {
  test("keeps Workspace warm-start readiness inside the container host", async () => {
    const { createWorkspaceWarmPoolRuntime } = await import("./workspace-container-pool");
    const calls: string[] = [];
    const host = {
      async startWarmContainer(env: Record<string, string>, inactivityTimeoutMs: number) {
        calls.push(`start ${env.PORT} ${env.MOUNT_POINT} ${inactivityTimeoutMs}`);
      },
      async destroyWarmContainer() {
        calls.push("destroy");
      },
      async isWarmContainerHealthy() {
        calls.push("healthy");
        return true;
      },
      async getWorkspaceContainer() {
        throw new Error("readiness should stay in the host DO");
      },
    };
    const runtime = createWorkspaceWarmPoolRuntime({
      CONTAINER_SLEEP_AFTER: "2m",
      WorkspaceContainerHost: namespaceFor(host),
      WARM_POOL_REFRESH_INTERVAL: "10000",
      WARM_POOL_TARGET: "2",
    });

    await runtime.startContainer("warm-a");
    await expect(runtime.isContainerRunning("warm-a")).resolves.toBe(true);

    expect(calls).toEqual(["start 8080 /workspace 120000", "healthy"]);
  });

  test("retries Workspace container placement while waiting for health", async () => {
    const { startWorkspaceContainerAndWait } = await import("./workspace-container-pool");
    const calls: string[] = [];
    let healthAttempts = 0;
    const container = {
      running: false,
      async setInactivityTimeout(durationMs: number) {
        calls.push(`timeout ${durationMs}`);
      },
      start() {
        calls.push("start");
      },
      getTcpPort() {
        return {
          async fetch() {
            healthAttempts += 1;
            calls.push(`health ${healthAttempts}`);
            if (healthAttempts < 3) {
              throw new Error(
                "There is no container instance that can be provided to this Durable Object, try again later",
              );
            }
            container.running = true;
            return new Response(null, { status: 200 });
          },
        } as unknown as Fetcher;
      },
    };

    await startWorkspaceContainerAndWait(container, { PORT: "8080" }, 120_000, {
      attempts: 3,
      wait: async () => {},
    });

    expect(calls).toEqual([
      "timeout 120000",
      "start",
      "health 1",
      "start",
      "health 2",
      "start",
      "health 3",
    ]);
  });
});

function namespaceFor<T>(stub: T): DurableObjectNamespace<WorkspaceContainerHost> {
  return {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace<WorkspaceContainerHost>;
}
