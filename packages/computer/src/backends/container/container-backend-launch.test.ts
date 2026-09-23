// The image and the size have to survive a restart.
//
// connect() and the readiness loop reach the platform through
// different host methods, so a spec assembled separately in each place
// drifts without anything failing: the restart drops what the initial
// start was given, and the replacement container comes up smaller, or
// on a different image, than the one it replaced. Nothing observes
// that until a build runs out of memory.
//
// These drive the backend far enough to capture both calls and compare
// them. The connect() attempt is expected to fail — there is no
// container to dial — which is fine, because the assertion is about
// what the host was asked for, not about reaching a session.
import { describe, expect, test } from "vitest";

import { ContainerBackend } from "./container-backend.js";
import type { ContainerRuntimeInfo, IWorkspaceContainerAPI } from "./container-host.js";
import type { ContainerLaunchSpec } from "./container-launch-record.js";

function recordingHost() {
  const specs: { method: "start" | "restart"; spec: ContainerLaunchSpec }[] = [];
  const info: ContainerRuntimeInfo = {
    runtimeId: "runtime-1",
    clientSecret: "00112233445566778899aabbccddeeff",
    outcome: "launched",
  };
  const host: IWorkspaceContainerAPI = {
    async start(spec) {
      specs.push({ method: "start", spec });
      return info;
    },
    async restart(spec) {
      specs.push({ method: "restart", spec });
      return info;
    },
    async interceptOutboundHttp() {},
    async interceptAllOutboundHttp() {},
    // Never healthy, so the readiness loop exhausts its attempts and
    // takes the restart path. That is the path under test.
    async fetchPort() {
      return new Response(null, { status: 503 });
    },
    port() {
      throw new Error("not used");
    },
    async setInactivityTimeout() {},
    async status() {
      return { running: true, exit: null };
    },
    async exitInfo() {
      return null;
    },
  };
  return { host, specs };
}

function backendWith(options: { name?: string; instance?: ContainerInstanceSize } = {}) {
  const { host, specs } = recordingHost();
  const backend = new ContainerBackend({
    container: () => ({ getWorkspaceContainer: () => host }),
    workspace: { binding: "SESSIONS", id: "session-1" },
    // One restart, then give up. Enough to capture both launch paths.
    restartAttempts: 1,
    connectTimeoutMs: 1_000,
    healthProbeTimeoutMs: 50,
    healthRetryInitialDelayMs: 10,
    healthRetryMaxDelayMs: 20,
    heartbeatIntervalMs: 0,
    ...options,
  });
  return { backend, specs };
}

describe("both launch paths request the same container", () => {
  test("the restart carries the image the initial start carried", async () => {
    const { backend, specs } = backendWith({ name: "toolchain" });

    await backend.connect().catch(() => undefined);

    const start = specs.find((call) => call.method === "start");
    const restart = specs.find((call) => call.method === "restart");
    expect(start?.spec.name).toBe("toolchain");
    expect(restart?.spec.name).toBe("toolchain");
  });

  test("the restart carries the instance size the initial start carried", async () => {
    const instance = { vcpu: 16, memoryMib: 32768, diskMb: 64000 };
    const { backend, specs } = backendWith({ instance });

    await backend.connect().catch(() => undefined);

    const start = specs.find((call) => call.method === "start");
    const restart = specs.find((call) => call.method === "restart");
    expect(start?.spec.instance).toEqual(instance);
    expect(restart?.spec.instance).toEqual(instance);
  });

  test("every launch names an image even when the caller does not", async () => {
    const { backend, specs } = backendWith();

    await backend.connect().catch(() => undefined);

    expect(specs.length).toBeGreaterThan(1);
    for (const call of specs) {
      expect(call.spec.name).toBe("app");
    }
  });
});
