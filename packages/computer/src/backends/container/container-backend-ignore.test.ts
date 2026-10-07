// How ContainerBackend configures and checks MOUNT_IGNORE. The first
// suite stops before the upgrade; the second stubs WebSocketPair, a
// workerd global the node runner does not provide, to run connect()
// through to the check. The comparison logic and the error text have
// their own suite in ignore-assertion.test.ts, and the end-to-end
// behavior is covered in computerd's cli tests against a real FUSE
// mount.
import { afterEach, describe, expect, test, vi } from "vitest";

import { ContainerBackend } from "./container-backend.js";
import type { ContainerRuntimeInfo, IWorkspaceContainerAPI } from "./container-host.js";
import type { ContainerLaunchSpec } from "./container-launch-record.js";
import { ContainerIgnoreMismatchError } from "./ignore-assertion.js";

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
      const path = new URL(url instanceof Request ? url.url : url).pathname;
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
  test("throws on a pattern computerd would refuse, before any container starts", () => {
    // Otherwise the typo surfaces as a daemon that exits during startup.
    const { host, starts } = fakeHost();
    expect(() => backendWith(host, ["**/node_modules", "node_modules"])).toThrow(
      /"\/node_modules" or "\*\*\/node_modules"/,
    );
    expect(starts).toHaveLength(0);
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
    await backendWith(host, ["**/node_modules", "!/vendor/node_modules", "/dist"])
      .connect()
      .catch(() => undefined);

    expect(starts).toHaveLength(1);
    expect(starts[0]?.env?.MOUNT_IGNORE).toBe("**/node_modules,!/vendor/node_modules,/dist");
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

// Drives connect() through the upgrade, so the ignore check runs against a
// container that enforces its client secret the way computerd does: every
// route except /health needs the bearer token.
describe("ContainerBackend ignore check on a full connect", () => {
  const SECRET = "00112233445566778899aabbccddeeff";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Enough of a WebSocket for capnweb to attach to and for the backend to
  // close. Nothing is sent over it in these tests.
  class FakeSocket {
    readyState = 1;
    accept() {}
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {
      this.readyState = 3;
    }
  }

  function connectingHost(ignore: Record<string, unknown>) {
    let backend: ContainerBackend | undefined;
    const infoAuth: (string | null)[] = [];
    const host: IWorkspaceContainerAPI = {
      async start() {
        return { runtimeId: "runtime-1", clientSecret: SECRET, outcome: "launched" };
      },
      async restart() {
        throw new Error("not used");
      },
      async interceptOutboundHttp() {},
      async interceptAllOutboundHttp() {},
      async fetchPort(_port, url, init) {
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        const auth = new Headers(init?.headers).get("authorization");
        if (path === "/health") return new Response("ok");
        if (path === "/__computerd/info") infoAuth.push(auth);
        if (auth !== `Bearer ${SECRET}`) return new Response(null, { status: 401 });
        if (path === "/connect") {
          // computerd dials back as soon as it is told where to go.
          await backend
            ?.handleFetch(
              new Request("http://computer.internal/api", {
                headers: { upgrade: "websocket", authorization: `Bearer ${SECRET}` },
              }),
            )
            // The 101 Response is a workerd-only shape; the upgrade has
            // already been handed over by the time it is built.
            .catch(() => undefined);
          return new Response(null, { status: 200 });
        }
        if (path === "/__computerd/info") {
          return Response.json({ backend: { kind: "fuse" }, mountPoint: "/workspace", ignore });
        }
        return new Response(null, { status: 404 });
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
    return {
      host,
      infoAuth,
      attach(b: ContainerBackend) {
        backend = b;
      },
    };
  }

  function backendFor(fake: ReturnType<typeof connectingHost>, ignore: readonly string[]) {
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      },
    );
    const backend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => fake.host }),
      workspace: { binding: "SESSIONS", id: "session-1" },
      restartAttempts: 0,
      connectTimeoutMs: 2_000,
      heartbeatIntervalMs: 0,
      ignore,
    });
    fake.attach(backend);
    return backend;
  }

  test("reads /__computerd/info with the client secret", async () => {
    const fake = connectingHost({
      supported: true,
      root: "/tmp/workspace",
      patterns: ["**/node_modules", "/dist"],
    });
    const handle = await backendFor(fake, ["**/node_modules", "/dist"]).connect();

    expect(fake.infoAuth).toEqual([`Bearer ${SECRET}`]);
    expect(handle.ignore).toEqual({
      patterns: ["**/node_modules", "/dist"],
      root: "/tmp/workspace",
      mountPoint: "/workspace",
      supported: true,
    });
    await handle.close();
  });

  test("accepts a declaration spelled with the mount point", async () => {
    // computerd strips the mount prefix from "/workspace/dist" and
    // applies "/dist". The declaration means the same thing.
    const fake = connectingHost({ supported: true, root: "/tmp/workspace", patterns: ["/dist"] });
    const handle = await backendFor(fake, ["/workspace/dist"]).connect();
    await handle.close();
  });

  test("still rejects a real mismatch", async () => {
    const fake = connectingHost({ supported: true, root: "/tmp/workspace", patterns: ["/dist"] });
    await expect(backendFor(fake, ["/node_modules"]).connect()).rejects.toBeInstanceOf(
      ContainerIgnoreMismatchError,
    );
  });

  test("rejects a computerd that reports paths instead of patterns", async () => {
    // A computerd from before patterns would have refused or misread
    // "**/node_modules", so it must not pass for one that applied it.
    const fake = connectingHost({ supported: true, root: "/tmp/workspace", paths: ["dist"] });
    await expect(backendFor(fake, ["/dist"]).connect()).rejects.toThrow(
      /does not support MOUNT_IGNORE patterns/,
    );
  });
});
