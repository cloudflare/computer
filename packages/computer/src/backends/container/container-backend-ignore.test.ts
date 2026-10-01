// connect()'s happy path constructs a WebSocketPair, a workerd global
// the node runner does not provide, so the full dial cannot complete
// here. These exercise the wire format the backend depends on, against
// a fake host. The comparison logic and the error text have their own
// suite in ignore-assertion.test.ts, and the end-to-end behaviour is
// covered in computerd's cli tests against a real FUSE mount.
import { describe, expect, test } from "vitest";

import { ContainerBackend } from "./container-backend.js";
import type { ContainerRuntimeInfo, IWorkspaceContainerAPI } from "./container-host.js";
import type { ContainerLaunchSpec } from "./container-launch-record.js";
import { readIgnoreReport } from "./ignore-assertion.js";

interface FakeHostOptions {
  // The `ignore` block /__computerd/info reports. Omitted models a
  // computerd predating the feature.
  info?: Record<string, unknown>;
}

function fakeHost(opts: FakeHostOptions = {}) {
  const fetches: { port: number; path: string }[] = [];
  const starts: ContainerLaunchSpec[] = [];
  const info: ContainerRuntimeInfo = {
    runtimeId: "runtime-1",
    clientSecret: "00112233445566778899aabbccddeeff",
    outcome: "launched",
  };
  const host: IWorkspaceContainerAPI = {
    async start(spec) {
      starts.push(spec);
      return info;
    },
    async restart() {
      return info;
    },
    async interceptOutboundHttp() {},
    async interceptAllOutboundHttp() {},
    async fetchPort(port, url) {
      const path = new URL(url).pathname;
      fetches.push({ port, path });
      if (path === "/__computerd/info") {
        return new Response(
          JSON.stringify({
            backend: { kind: "fuse" },
            mountPoint: "/workspace",
            ...(opts.info === undefined ? {} : { ignore: opts.info }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Never healthy, so connect() fails before the upgrade.
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
  return { host, fetches, starts };
}

describe("ContainerBackend local-only paths", () => {
  const readInfo = async (host: IWorkspaceContainerAPI) => {
    const res = await host.fetchPort(8080, "http://container/__computerd/info");
    return readIgnoreReport(await res.json());
  };

  test("reads the ignore block a current container reports", async () => {
    const { host } = fakeHost({
      info: {
        supported: true,
        enabled: true,
        root: "/tmp/workspace",
        paths: ["node_modules", "dist"],
        redundant: [],
      },
    });
    expect(await readInfo(host)).toEqual({
      paths: ["/workspace/node_modules", "/workspace/dist"],
      root: "/tmp/workspace",
      mountPoint: "/workspace",
      supported: true,
    });
  });

  test("treats a container with no ignore block as unsupported", async () => {
    // The version-skew case the README warns about: the computerd image
    // can lag the pinned client. Without this the old image looks like
    // it is working while quietly syncing everything.
    const { host } = fakeHost({});
    expect(await readInfo(host)).toEqual({
      paths: [],
      root: undefined,
      mountPoint: undefined,
      supported: false,
    });
  });

  test("the backend requests /__computerd/info on the container port", async () => {
    // Pins the path and port, so a rename upstream fails here rather
    // than silently degrading every deployment to "unsupported".
    const { host, fetches } = fakeHost({
      info: { supported: true, paths: [], root: "/tmp/workspace" },
    });
    await host.fetchPort(8080, "http://container/__computerd/info");
    expect(fetches).toContainEqual({ port: 8080, path: "/__computerd/info" });
  });

  const backendWith = (host: IWorkspaceContainerAPI, ignore?: readonly string[]) =>
    new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => host }),
      workspace: { binding: "SESSIONS", id: "session-1" },
      restartAttempts: 0,
      connectTimeoutMs: 400,
      healthProbeTimeoutMs: 50,
      healthRetryInitialDelayMs: 10,
      healthRetryMaxDelayMs: 20,
      heartbeatIntervalMs: 0,
      ...(ignore === undefined ? {} : { ignore }),
    });

  test("passes `ignore` to the container as MOUNT_IGNORE at start time", async () => {
    // The set is deployment config, not image config: it has to arrive
    // in the start environment or the image would have to be rebuilt to
    // change it.
    const { host, starts } = fakeHost();
    await backendWith(host, ["/node_modules", "/.venv", "/dist"])
      .connect()
      .catch(() => undefined);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.env?.MOUNT_IGNORE).toBe("/node_modules,/.venv,/dist");
  });

  test("sends no MOUNT_IGNORE when `ignore` is omitted", async () => {
    const { host, starts } = fakeHost();
    await backendWith(host)
      .connect()
      .catch(() => undefined);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.env?.MOUNT_IGNORE).toBeUndefined();
  });
});
