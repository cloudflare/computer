import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

import { resolveFuseBackend } from "../fuse/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const cliPath = path.join(packageRoot, "dist", "cli", "computerd.cjs");

test("computerd rejects relative MOUNT_POINT values", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: { ...process.env, MOUNT_POINT: "relative-workspace", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(/MOUNT_POINT must be an absolute path/);
});

test("computerd rejects non-numeric EXEC_LOG_MAX_BYTES values", async () => {
  // Boot the daemon with garbage in EXEC_LOG_MAX_BYTES; it should
  // refuse to start. Previously Number('foo') -> NaN silently
  // disabled log eviction (every append exceeded the cap).
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/computerd-mount-not-used",
      PORT: String(port),
      EXEC_LOG_MAX_BYTES: "foo",
      FUSE_MOUNT: "none",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(/EXEC_LOG_MAX_BYTES must be a positive integer/);
});

test("computerd appends to LOG_FILE when set, in addition to stdout/stderr", async (_t) => {
  // Boot the daemon with LOG_FILE pointed at a temp file. The
  // startup banner line on stdout should also show up in the file,
  // proving the console patch landed and didn't replace the original
  // writers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-log-"));
  const logFile = path.join(dir, "computerd.log");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", LOG_FILE: logFile },
  });
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));

  const contents = await fs.readFile(logFile, "utf8");
  expect(contents).toMatch(/\[info\] computerd listening on/);
});

test("computerd exposes file IO through real FUSE when FUSE_MOUNT=fuse", async (ctx) => {
  // Only meaningful on linux hosts with /dev/fuse available. Use
  // the explicit FUSE_MOUNT=fuse value so the test fails loudly if
  // /dev/fuse goes missing rather than silently sliding onto the
  // shim under auto-detection.
  const backend = await resolveFuseBackend("auto");
  if (backend.kind !== "fuse") {
    ctx.skip(`requires real FUSE; auto resolved to ${backend.kind}`);
    return;
  }

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "fuse" } });

  const health = await request(`http://127.0.0.1:${port}/health`);
  expect(health.statusCode).toBe(200);
  expect(health.body).toBe("ok\n");

  const root = await request(`http://127.0.0.1:${port}/`);
  expect(root.statusCode).toBe(200);
  expect(JSON.parse(root.body)).toEqual({});

  const info = await request(`http://127.0.0.1:${port}/__computerd/info`);
  expect(info.statusCode).toBe(200);
  expect(JSON.parse(info.body)).toEqual({
    backend: { kind: "fuse" },
    mountPoint,
    port,
    store: { kind: "memory" },
  });

  await fs.mkdir(path.join(mountPoint, "dir"));
  await fs.writeFile(path.join(mountPoint, "dir", "hello.txt"), "hello fuse");
  expect(await fs.readFile(path.join(mountPoint, "dir", "hello.txt"), "utf8")).toBe("hello fuse");
});

test("/api serves a capnweb WorkspaceRPC session", async (_ctx) => {
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/api` });
  try {
    // hasObjects against a fresh DB returns the empty subset.
    expect(await client.sync.hasObjects([])).toEqual([]);
    // fetchChanges streams zero entries against a fresh DB.
    const { stream } = await client.sync.fetchChanges({
      after: { rev: 0, path: null },
      ignore: [],
    });
    const reader = stream.getReader();
    const entries = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      entries.push(value);
    }
    expect(entries).toEqual([]);
  } finally {
    await client.close();
  }
});

test("/api refuses anything that is not a websocket handshake", async (_ctx) => {
  // /api carries one transport. A caller that arrives over plain HTTP,
  // or botches the handshake, should learn that from the status rather
  // than from a capnweb error several calls later.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });
  const base = `http://127.0.0.1:${port}/api`;

  // No Upgrade header at all: never reaches the upgrade listener.
  const plainGet = await fetch(base);
  expect(plainGet.status).toBe(400);
  expect(await plainGet.text()).toMatch(/websocket/i);

  const post = await fetch(base, { method: "POST", body: "[]" });
  expect(post.status).toBe(400);

  // An upgrade attempt naming a version we do not speak gets 426 and
  // the versions we do speak, per the websocket specification.
  const badVersion = await rawRequest(port, [
    "GET /api HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 7",
  ]);
  expect(badVersion).toMatch(/^HTTP\/1\.1 426 /);
  expect(badVersion).toMatch(/Sec-WebSocket-Version: 13, 8/i);

  // A handshake that names no version is malformed, not a version
  // mismatch: nothing was negotiated to disagree about. Same for a
  // repeated header, which node joins into "13, 13", and for a value
  // that is not a whole number.
  for (const [label, extra] of [
    ["absent", []],
    ["repeated", ["Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 13"]],
    ["non-numeric", ["Sec-WebSocket-Version: banana"]],
    ["fractional", ["Sec-WebSocket-Version: 13.5"]],
  ] as const) {
    const malformed = await rawRequest(port, [
      "GET /api HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...extra,
    ]);
    expect(malformed, `version ${label}`).toMatch(/^HTTP\/1\.1 400 /);
  }

  // A handshake missing its key is malformed, not a version problem.
  const noKey = await rawRequest(port, [
    "GET /api HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
  ]);
  expect(noKey).toMatch(/^HTTP\/1\.1 400 /);

  // A subpath under /api is not the session endpoint: only the exact
  // path upgrades.
  const subpath = await rawRequest(port, [
    "GET /api/watermarks HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ]);
  expect(subpath).toMatch(/^HTTP\/1\.1 404 /);

  // An unknown path is still a 404, upgrade header or not.
  const unknown = await rawRequest(port, [
    "GET /nope HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ]);
  expect(unknown).toMatch(/^HTTP\/1\.1 404 /);
});

test("/api/watermarks reports sync revisions over plain HTTP", async (_ctx) => {
  // Samplers want three numbers on an interval. Opening an RPC session
  // per sample is the wrong shape for that.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-watermarks-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const res = await fetch(`http://127.0.0.1:${port}/api/watermarks`);
  expect(res.status).toBe(200);

  // Reads only. The shared method guard covers every read route, and
  // this one has to sit under it like the rest.
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const rejected = await fetch(`http://127.0.0.1:${port}/api/watermarks`, { method });
    expect(rejected.status, `${method} /api/watermarks`).toBe(405);
  }

  const body = await res.json();
  expect(body).toMatchObject({
    currentRev: expect.any(Number),
    pushRev: expect.any(Number),
    fetchCursor: { rev: expect.any(Number) },
  });
});

test("/__computerd/stats returns DOFS table sizes and process memory", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-stats-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const stats = await request(`http://127.0.0.1:${port}/__computerd/stats`);
  expect(stats.statusCode).toBe(200);
  expect(stats.headers["content-type"]).toMatch(/application\/json/);

  const body = JSON.parse(stats.body);
  // DOFS table counts and blob byte totals. The root inode always
  // exists, so vfs_nodes_count is at least 1; everything else is
  // a non-negative count. Asserting Number.isFinite catches a
  // handler that returned NaN, and the non-negative bound catches
  // a future regression that returned -1 from a malformed read.
  const counts = [
    "vfs_nodes_count",
    "vfs_dirents_count",
    "vfs_chunks_count",
    "vfs_blobs_count",
    "vfs_blob_bytes_total",
    "vfs_blobs_orphan",
    "vfs_blob_bytes_orphan",
  ] as const;
  for (const key of counts) {
    expect(typeof body[key], key).toBe("number");
    expect(Number.isFinite(body[key]), key).toBe(true);
    expect(body[key], key).toBeGreaterThanOrEqual(0);
  }
  expect(body.vfs_nodes_count).toBeGreaterThanOrEqual(1);

  // Process memory snapshot. RSS and heap_total are strictly
  // positive in any live process; the rest are non-negative.
  expect(body.rss).toBeGreaterThan(0);
  expect(body.heap_total).toBeGreaterThan(0);
  for (const key of ["heap_used", "external", "array_buffers"] as const) {
    expect(typeof body[key], key).toBe("number");
    expect(Number.isFinite(body[key]), key).toBe(true);
    expect(body[key], key).toBeGreaterThanOrEqual(0);
  }
});

test("computerd exposes file IO through the userspace shim when FUSE_MOUNT=shim", async (_ctx) => {
  // No FUSE backend required — the shim runs in user space and is
  // explicitly opt-in via FUSE_MOUNT=shim. Mirrors the real-FUSE
  // test above but for the dev fallback path.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "shim" } });

  const info = await request(`http://127.0.0.1:${port}/__computerd/info`);
  expect(info.statusCode).toBe(200);
  const parsed = JSON.parse(info.body);
  expect(parsed.backend.kind).toBe("shim");
  expect(parsed.mountPoint).toBe(mountPoint);

  // Disk → VFS: writing into the mount point should land in the VFS
  // and round-trip back through the shim onto disk.
  await fs.mkdir(path.join(mountPoint, "dir"));
  await fs.writeFile(path.join(mountPoint, "dir", "hello.txt"), "hello shim");
  expect(await fs.readFile(path.join(mountPoint, "dir", "hello.txt"), "utf8")).toBe("hello shim");
});

test("FUSE_MOUNT=shim materialises an RPC push under the mount point", async (_ctx) => {
  // End-to-end version of the cross-namespace fix: a peer pushes a
  // file at `${MOUNT_POINT}/repo/a.txt` into computerd's VFS over
  // capnweb, and the shim drops it on disk at the same absolute
  // path. The on-disk read is what proves the mountPoint plumbing
  // works — a regression would surface here as ENOENT.
  const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
  const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const { pushOnce } = await import("@cloudflare/computer-rpc/driver");

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-push-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "shim" } });

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/api` });
  onTestFinished(() => client.close());

  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, Date.now);
  const fsWrapper = new WorkspaceFilesystem(db);
  await fsWrapper.mkdir(`${mountPoint}/repo`, { recursive: true });
  await fsWrapper.writeFile(`${mountPoint}/repo/a.txt`, "alpha");

  // The exact rev count depends on how many ancestor directories
  // mkdir(recursive) had to materialise under the tmpdir mount
  // point. The on-disk assertion below is the real contract.
  expect(await pushOnce(db, client.sync)).toBeGreaterThan(0);

  expect(await fs.readFile(path.join(mountPoint, "repo", "a.txt"), "utf8")).toBe("alpha");
});

test("computerd rejects unknown FUSE_MOUNT values", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/computerd-mount-not-used",
      PORT: String(port),
      FUSE_MOUNT: "bogus",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(/FUSE_MOUNT must be one of/);
});

test.each([
  ["DISABLE_FUSE", "1"],
  ["FUSE_SHIM", "1"],
  ["WSD_FUSE_BACKEND", "linux"],
])("computerd refuses to boot when legacy %s is set", async (name, value) => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/computerd-mount-not-used",
      PORT: String(port),
      [name]: value,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(new RegExp(`${name} is no longer supported`));
  expect(stderr).toMatch(/FUSE_MOUNT/);
});

test("/connect re-dial tears down the prior WebSocket session", async (_ctx) => {
  // After a DO hibernate, the new incarnation calls POST /connect
  // again to bootstrap a fresh capnweb session against the still-
  // running computerd. computerd must close the previous outbound socket before
  // opening the new one — otherwise the old session leaks for the
  // life of the container and the DO ends up with two halves of two
  // sessions tangled together.
  const { WebSocketServer } = await import("ws");
  const peerPort = await getAvailablePort();
  const opened = [];
  const upgradeAuthorizations = [];
  const peerSockets = new Set();
  // Deliberately non-default paths: the daemon must use what the
  // request names, not paths of its own.
  const peerServer = http.createServer((req, res) => {
    if (req.url === "/probe") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404).end();
  });
  peerServer.on("connection", (sock) => {
    peerSockets.add(sock);
    sock.on("close", () => peerSockets.delete(sock));
  });
  const wss = new WebSocketServer({ noServer: true });
  peerServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/socket") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The host arms a slot for this upgrade and hands the first arrival
      // its session, so the dial-back has to prove it is this daemon.
      upgradeAuthorizations.push(req.headers.authorization ?? null);
      const entry = { closed: false, closeCode: null };
      ws.on("close", (code) => {
        entry.closed = true;
        entry.closeCode = code;
      });
      opened.push(entry);
    });
  });
  await new Promise((resolve) => peerServer.listen(peerPort, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise((resolve) => {
        // Force-destroy any lingering TCP sockets so peerServer.close()
        // can return; otherwise an unkilled computerd-side WS keeps the
        // server open and the test hangs at teardown.
        for (const sock of peerSockets) sock.destroy();
        wss.close();
        peerServer.close(() => resolve());
      }),
  );

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const peerUrl = `http://127.0.0.1:${peerPort}`;
  const connect = async () => {
    const res = await postJson(`http://127.0.0.1:${port}/connect`, {
      base: peerUrl,
      health: "/probe",
      api: "/socket",
    });
    expect(res.statusCode).toBe(200);
  };

  await connect();
  // Wait for the first WS to actually attach on the peer side before
  // issuing the second /connect; otherwise the assert race is flaky.
  await waitFor(() => opened.length === 1);

  await connect();
  await waitFor(() => opened.length === 2);
  // The prior socket must be closed by the time the new one lands.
  await waitFor(() => opened[0].closed);
  expect(opened[0].closed).toBe(true, "first peer WS should be closed after re-POST /connect");
  expect(opened[1].closed).toBe(false, "second peer WS should still be open");

  // No secret is configured here, so there is nothing to present.
  expect(upgradeAuthorizations).toEqual([null, null]);
});

test("/connect presents the shared secret on the dial-back", async (_ctx) => {
  // The host arms a slot for this upgrade and gives the first arrival its
  // session. Anything that can reach the host's endpoint — which includes
  // every command this daemon runs — could take the daemon's place, so
  // the dial has to carry the secret the daemon was launched with.
  const { WebSocketServer } = await import("ws");
  const secret = "0123456789abcdef0123456789abcdef";
  const peerPort = await getAvailablePort();
  const seen = [];
  const peerSockets = new Set();
  const peerServer = http.createServer((req, res) => {
    if (req.url === "/probe") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404).end();
  });
  peerServer.on("connection", (sock) => {
    peerSockets.add(sock);
    sock.on("close", () => peerSockets.delete(sock));
  });
  const wss = new WebSocketServer({ noServer: true });
  peerServer.on("upgrade", (req, socket, head) => {
    seen.push(req.headers.authorization ?? null);
    wss.handleUpgrade(req, socket, head, () => {});
  });
  await new Promise((resolve) => peerServer.listen(peerPort, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise((resolve) => {
        for (const sock of peerSockets) sock.destroy();
        wss.close();
        peerServer.close(() => resolve());
      }),
  );

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-dialback-"));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", RPC_CLIENT_SECRET: secret },
  });

  const res = await postJson(`http://127.0.0.1:${port}/connect`, {
    base: `http://127.0.0.1:${peerPort}`,
    health: "/probe",
    api: "/socket",
  });
  expect(res.statusCode, "the /connect request itself needs the token too").toBe(401);

  const authorized = await postJson(
    `http://127.0.0.1:${port}/connect`,
    { base: `http://127.0.0.1:${peerPort}`, health: "/probe", api: "/socket" },
    { authorization: `Bearer ${secret}` },
  );
  expect(authorized.statusCode).toBe(200);

  await waitFor(() => seen.length === 1);
  expect(seen[0]).toBe(`Bearer ${secret}`);
});

test("/connect rejects a body that does not name every part", async (_ctx) => {
  // The daemon assembles no host paths of its own, so a request that
  // leaves one out has to be refused rather than defaulted.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });
  const url = `http://127.0.0.1:${port}/connect`;

  const cases = [
    [{}, "empty body"],
    [{ health: "/health", api: "/api" }, "no base"],
    [{ base: "http://127.0.0.1:1", api: "/api" }, "no health"],
    [{ base: "http://127.0.0.1:1", health: "/health" }, "no api"],
    [{ base: "ftp://127.0.0.1:1", health: "/health", api: "/api" }, "unsupported scheme"],
    [{ base: "http://127.0.0.1:1", health: "health", api: "/api" }, "health lacks a slash"],
    [{ base: "http://127.0.0.1:1", health: "/health", api: "api" }, "api lacks a slash"],
    [
      { base: "http://127.0.0.1:1", health: "/health", api: "http://elsewhere/api" },
      "api is an absolute address",
    ],
    [
      { base: "http://127.0.0.1:1", health: "//elsewhere/health", api: "/api" },
      "health is protocol relative",
    ],
  ];

  for (const [body, label] of cases) {
    const res = await postJson(url, body);
    expect(res.statusCode, `${label} should be refused`).toBe(400);
  }

  // Control: a well-formed body must clear validation. Port 1 has
  // nothing listening, so it gets as far as the health probe and
  // fails there instead, which is a different status.
  const ok = await postJson(url, {
    base: "http://127.0.0.1:1",
    health: "/health",
    api: "/api",
    healthTimeoutMs: 250,
  });
  expect(ok.statusCode, "a complete body should reach the health probe").toBe(502);
});

async function startComputerd({
  port,
  mountPoint,
  env = {},
}: {
  port: number;
  mountPoint: string;
  env?: Record<string, string>;
}) {
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: { ...process.env, MOUNT_POINT: mountPoint, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  onTestFinished(async () => {
    await stopProcess(child);
    await fs.rm(mountPoint, { recursive: true, force: true });
  });

  await waitForHTTPOK(`http://127.0.0.1:${port}/health`, child, () => stderr || stdout);
  return child;
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      expect(typeof address).toBe("object");
      expect(address).not.toBe(null);
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForExit(child, timeoutMs = 2_000) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for computerd to exit"));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

async function waitForHTTPOK(url, child, output, timeoutMs = 5_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`computerd exited before becoming ready: ${child.exitCode}\n${output()}`);
    }

    try {
      const response = await request(url);
      if (response.statusCode === 200) return;
    } catch (error) {
      if (!isConnectionError(error)) throw error;
    }

    await delay(50);
  }

  throw new Error(`timed out waiting for ${url}\n${output()}`);
}

// Write a request onto a raw socket and return the response head.
// http.request() will not send a malformed websocket handshake, and
// fetch() will not send one at all, so the handshake cases need this.
function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.once("error", reject);
    // The server may hold the socket open after refusing the
    // handshake, so settle on the end of the response head.
    const settle = () => {
      socket.destroy();
      resolve(buf);
    };
    socket.on("data", () => {
      if (buf.includes("\r\n\r\n")) settle();
    });
    socket.once("close", () => resolve(buf));
    setTimeout(settle, 2_000);
  });
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "GET", ...options }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ body, headers: response.headers, statusCode: response.statusCode });
      });
    });

    request.once("error", reject);
    request.setTimeout(1_000, () => {
      request.destroy(new Error(`request timed out: ${url}`));
    });
    request.end();
  });
}

function isConnectionError(error) {
  return error && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("waitFor: predicate did not become true within the timeout");
}

function postJson(url, body, headers = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let buf = "";
        response.on("data", (chunk) => {
          buf += chunk;
        });
        response.on("end", () => {
          resolve({ body: buf, headers: response.headers, statusCode: response.statusCode });
        });
      },
    );
    req.once("error", reject);
    req.write(payload);
    req.end();
  });
}

function stopProcess(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for computerd to exit"));
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

test("RPC_CLIENT_SECRET gates the HTTP surface but not /health", async (_ctx) => {
  const secret = "0123456789abcdef0123456789abcdef";
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-auth-"));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", RPC_CLIENT_SECRET: secret },
  });
  const base = `http://127.0.0.1:${port}`;
  const bearer = { authorization: `Bearer ${secret}` };

  // Readiness has to stay reachable: the host polls it before it has
  // any session, and a gated probe turns a bad token into what looks
  // like a container that never came up.
  expect((await request(`${base}/health`)).statusCode).toBe(200);

  for (const route of ["/", "/__computerd/info", "/api/watermarks"]) {
    const anonymous = await request(`${base}${route}`);
    expect(anonymous.statusCode, `${route} without a token`).toBe(401);
    const authorized = await request(`${base}${route}`, { headers: bearer });
    expect(authorized.statusCode, `${route} with the token`).toBe(200);
  }

  // Wrong token, right shape.
  const wrong = await request(`${base}/__computerd/info`, {
    headers: { authorization: `Bearer ${"f".repeat(secret.length)}` },
  });
  expect(wrong.statusCode).toBe(401);

  // A token of a different length must not be treated as a match.
  const short = await request(`${base}/__computerd/info`, {
    headers: { authorization: "Bearer short" },
  });
  expect(short.statusCode).toBe(401);

  // The scheme token is case-insensitive per the HTTP grammar, and the
  // credentials may be preceded by more than one space.
  for (const header of [
    `Bearer ${secret}`,
    `bearer ${secret}`,
    `BEARER ${secret}`,
    `BeArEr ${secret}`,
    `Bearer   ${secret}`,
  ]) {
    const res = await request(`${base}/__computerd/info`, { headers: { authorization: header } });
    expect(res.statusCode, JSON.stringify(header)).toBe(200);
  }

  // Another scheme is not a bearer token.
  const basic = await request(`${base}/__computerd/info`, {
    headers: { authorization: `Basic ${secret}` },
  });
  expect(basic.statusCode).toBe(401);

  // /connect is gated too, and refused before its body is considered.
  const connect = await postJson(`${base}/connect`, {});
  expect(connect.statusCode).toBe(401);

  // The upgrade is gated as well.
  const upgrade = await rawRequest(port, [
    "GET /api HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ]);
  expect(upgrade).toMatch(/^HTTP\/1\.1 401 /);
});

test("without RPC_CLIENT_SECRET every route stays open", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-noauth-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });
  const base = `http://127.0.0.1:${port}`;

  for (const route of ["/health", "/", "/__computerd/info", "/api/watermarks"]) {
    expect((await request(`${base}${route}`)).statusCode, route).toBe(200);
  }
});

test("/__computerd/info reports the in-memory store by default", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const response = await request(`http://127.0.0.1:${port}/__computerd/info`);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).store).toEqual({ kind: "memory" });
});

test("/__computerd/info reports the file store and its path when COMPUTERD_DB is set", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  const storePath = path.join(storeDir, "state.db");
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const response = await request(`http://127.0.0.1:${port}/__computerd/info`);
  expect(JSON.parse(response.body).store).toEqual({
    kind: "file",
    path: storePath,
    fresh: true,
  });
});

test("computerd rejects a relative COMPUTERD_DB value", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/computerd-mount-not-used",
      PORT: String(port),
      FUSE_MOUNT: "none",
      COMPUTERD_DB: "state.db",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(/COMPUTERD_DB must be "memory" or an absolute path/);
});

test("computerd rejects a COMPUTERD_DB path inside the mount point", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/computerd-mount-not-used",
      PORT: String(port),
      FUSE_MOUNT: "none",
      COMPUTERD_DB: "/tmp/computerd-mount-not-used/state.db",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { code, stderr } = await waitForExit(child);
  expect(code).toBe(1);
  expect(stderr).toMatch(/must not sit inside the mount point/);
});

test("POST /__computerd/checkpoint leaves the store readable", async (_ctx) => {
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: path.join(storeDir, "state.db") },
  });

  const response = await request(`http://127.0.0.1:${port}/__computerd/checkpoint`, {
    method: "POST",
  });
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(typeof body.walFrames).toBe("number");
  expect(body.sizeBytes).toBeGreaterThan(0);
  expect(typeof body.durationMs).toBe("number");

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/api` });
  try {
    expect(await client.sync.hasObjects([])).toEqual([]);
  } finally {
    await client.close();
  }
});

test("POST /__computerd/checkpoint on an in-memory store reports no frames", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const response = await request(`http://127.0.0.1:${port}/__computerd/checkpoint`, {
    method: "POST",
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).walFrames).toBe(0);
});

test("/__computerd/checkpoint refuses a GET", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const response = await request(`http://127.0.0.1:${port}/__computerd/checkpoint`);
  expect(response.statusCode).toBe(405);
});

test("/__computerd/checkpoint requires the shared secret when one is set", async (_ctx) => {
  const secret = "checkpoint-secret";
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", RPC_CLIENT_SECRET: secret },
  });

  const unauthorized = await request(`http://127.0.0.1:${port}/__computerd/checkpoint`, {
    method: "POST",
  });
  expect(unauthorized.statusCode).toBe(401);

  const authorized = await request(`http://127.0.0.1:${port}/__computerd/checkpoint`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(authorized.statusCode).toBe(200);
});

test("/__computerd/stats reports the store size and free pages", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  await startComputerd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: path.join(storeDir, "state.db") },
  });

  const response = await request(`http://127.0.0.1:${port}/__computerd/stats`);
  const stats = JSON.parse(response.body);
  expect(stats.store_size_bytes).toBeGreaterThan(0);
  expect(typeof stats.store_freelist_count).toBe("number");
});

test("a write survives SIGTERM because the store is checkpointed after the unmount", async (_ctx) => {
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  const storePath = path.join(storeDir, "state.db");

  const firstPort = await getAvailablePort();
  const firstMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const child = await startComputerd({
    port: firstPort,
    mountPoint: firstMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
  const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
  const { pushOnce } = await import("@cloudflare/computer-rpc/driver");

  const writer = createWorkspaceClient({ url: `ws://127.0.0.1:${firstPort}/api` });
  try {
    const local = new Database(new SQLiteTestStorage());
    initializeSchema(local, Date.now);
    await new WorkspaceFilesystem(local).writeFile("/survives.txt", "written before SIGTERM");
    expect(await pushOnce(local, writer.sync)).toBeGreaterThan(0);
  } finally {
    await writer.close();
  }

  await stopProcess(child);

  const secondPort = await getAvailablePort();
  const secondMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port: secondPort,
    mountPoint: secondMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const reader = createWorkspaceClient({ url: `ws://127.0.0.1:${secondPort}/api` });
  try {
    const entry = await reader.sync.readEntry("/survives.txt");
    expect(entry).not.toBeNull();
  } finally {
    await reader.close();
  }
});

test("a file store brings the tree and the sync cursors back after a restart", async (_ctx) => {
  const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
  const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const { pushOnce } = await import("@cloudflare/computer-rpc/driver");

  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  const storePath = path.join(storeDir, "state.db");

  const firstPort = await getAvailablePort();
  const firstMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const first = await startComputerd({
    port: firstPort,
    mountPoint: firstMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const writer = createWorkspaceClient({ url: `ws://127.0.0.1:${firstPort}/api` });
  try {
    const local = new Database(new SQLiteTestStorage());
    initializeSchema(local, Date.now);
    const localFs = new WorkspaceFilesystem(local);
    await localFs.mkdir("/restart", { recursive: true });
    await localFs.writeFile("/restart/a.txt", "before the restart");
    expect(await pushOnce(local, writer.sync)).toBeGreaterThan(0);
  } finally {
    await writer.close();
  }

  const before = JSON.parse((await request(`http://127.0.0.1:${firstPort}/api/watermarks`)).body);
  expect(before.fetchCursor.rev).toBeGreaterThan(0);

  await stopProcess(first);

  const secondPort = await getAvailablePort();
  const secondMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port: secondPort,
    mountPoint: secondMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const after = JSON.parse((await request(`http://127.0.0.1:${secondPort}/api/watermarks`)).body);
  expect(after.currentRev).toBe(before.currentRev);
  expect(after.fetchCursor).toEqual(before.fetchCursor);

  const reader = createWorkspaceClient({ url: `ws://127.0.0.1:${secondPort}/api` });
  try {
    const entry = await reader.sync.readEntry("/restart/a.txt");
    expect(entry).not.toBeNull();
  } finally {
    await reader.close();
  }
});

test("an in-memory store comes back empty after a restart", async (_ctx) => {
  const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
  const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
  const { pushOnce } = await import("@cloudflare/computer-rpc/driver");

  const firstPort = await getAvailablePort();
  const firstMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const first = await startComputerd({
    port: firstPort,
    mountPoint: firstMount,
    env: { FUSE_MOUNT: "none" },
  });

  const writer = createWorkspaceClient({ url: `ws://127.0.0.1:${firstPort}/api` });
  try {
    const local = new Database(new SQLiteTestStorage());
    initializeSchema(local, Date.now);
    const localFs = new WorkspaceFilesystem(local);
    await localFs.mkdir("/restart", { recursive: true });
    await localFs.writeFile("/restart/a.txt", "before the restart");
    expect(await pushOnce(local, writer.sync)).toBeGreaterThan(0);
  } finally {
    await writer.close();
  }

  await stopProcess(first);

  const secondPort = await getAvailablePort();
  const secondMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port: secondPort,
    mountPoint: secondMount,
    env: { FUSE_MOUNT: "none" },
  });

  const after = JSON.parse((await request(`http://127.0.0.1:${secondPort}/api/watermarks`)).body);
  expect(after.fetchCursor).toEqual({ rev: 0, path: null });

  const reader = createWorkspaceClient({ url: `ws://127.0.0.1:${secondPort}/api` });
  try {
    expect(await reader.sync.readEntry("/restart/a.txt")).toBeNull();
  } finally {
    await reader.close();
  }
});

test("the exec log does not come back after a restart on a file store", async (_ctx) => {
  const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");

  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-store-"));
  onTestFinished(() => fs.rm(storeDir, { recursive: true, force: true }));
  const storePath = path.join(storeDir, "state.db");

  const firstPort = await getAvailablePort();
  const firstMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  const first = await startComputerd({
    port: firstPort,
    mountPoint: firstMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  let execId = "";
  const runner = createWorkspaceClient({ url: `ws://127.0.0.1:${firstPort}/api` });
  try {
    const handle = await runner.shell.exec({ source: "echo hello-from-before" });
    execId = handle.id;
    const reader = handle.events.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    await runner.close();
  }

  await stopProcess(first);

  const secondPort = await getAvailablePort();
  const secondMount = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-mount-"));
  await startComputerd({
    port: secondPort,
    mountPoint: secondMount,
    env: { FUSE_MOUNT: "none", COMPUTERD_DB: storePath },
  });

  const after = createWorkspaceClient({ url: `ws://127.0.0.1:${secondPort}/api` });
  try {
    await expect(after.shell.getExec({ id: execId })).rejects.toThrow();
  } finally {
    await after.close();
  }
});
