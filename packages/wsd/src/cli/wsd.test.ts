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
const cliPath = path.join(packageRoot, "dist", "cli", "wsd.cjs");

test("wsd rejects relative MOUNT_POINT values", async () => {
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

test("wsd rejects non-numeric EXEC_LOG_MAX_BYTES values", async () => {
  // Boot the daemon with garbage in EXEC_LOG_MAX_BYTES; it should
  // refuse to start. Previously Number('foo') -> NaN silently
  // disabled log eviction (every append exceeded the cap).
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/wsd-mount-not-used",
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

test("wsd appends to LOG_FILE when set, in addition to stdout/stderr", async (_t) => {
  // Boot the daemon with LOG_FILE pointed at a temp file. The
  // startup banner line on stdout should also show up in the file,
  // proving the console patch landed and didn't replace the original
  // writers.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-log-"));
  const logFile = path.join(dir, "wsd.log");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd({
    port,
    mountPoint,
    env: { FUSE_MOUNT: "none", LOG_FILE: logFile },
  });
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));

  const contents = await fs.readFile(logFile, "utf8");
  expect(contents).toMatch(/\[info\] wsd listening on/);
});

test("wsd exposes file IO through real FUSE when FUSE_MOUNT=fuse", async (ctx) => {
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
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "fuse" } });

  const health = await request(`http://127.0.0.1:${port}/health`);
  expect(health.statusCode).toBe(200);
  expect(health.body).toBe("ok\n");

  const root = await request(`http://127.0.0.1:${port}/`);
  expect(root.statusCode).toBe(200);
  expect(JSON.parse(root.body)).toEqual({});

  const info = await request(`http://127.0.0.1:${port}/__wsd/info`);
  expect(info.statusCode).toBe(200);
  expect(JSON.parse(info.body)).toEqual({
    backend: { kind: "fuse" },
    mountPoint,
    port,
  });

  await fs.mkdir(path.join(mountPoint, "dir"));
  await fs.writeFile(path.join(mountPoint, "dir", "hello.txt"), "hello fuse");
  expect(await fs.readFile(path.join(mountPoint, "dir", "hello.txt"), "utf8")).toBe("hello fuse");
});

test("/ws serves a capnweb WorkspaceRPC session", async (_ctx) => {
  const { createWorkspaceClient } = await import("@cloudflare/workspace-rpc/client");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/ws` });
  try {
    // hasObjects against a fresh DB returns the empty subset.
    expect(await client.sync.hasObjects([])).toEqual([]);
    // fetchChanges streams zero entries against a fresh DB.
    const { stream } = await client.sync.fetchChanges({ sinceRev: 0, ignore: [] });
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

test("/api serves a capnweb HTTP-batch WorkspaceRPC session", async (_ctx) => {
  const { newHttpBatchRpcSession } = await import("capnweb");
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  // HTTP batch flushes on first await; each call is a fresh session.
  const stub = newHttpBatchRpcSession(`http://127.0.0.1:${port}/api`);
  expect(await stub.sync.hasObjects([])).toEqual([]);
});

test("/__wsd/stats returns DOFS table sizes and process memory", async (_ctx) => {
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-stats-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const stats = await request(`http://127.0.0.1:${port}/__wsd/stats`);
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

test("wsd exposes file IO through the userspace shim when FUSE_MOUNT=shim", async (_ctx) => {
  // No FUSE backend required — the shim runs in user space and is
  // explicitly opt-in via FUSE_MOUNT=shim. Mirrors the real-FUSE
  // test above but for the dev fallback path.
  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "shim" } });

  const info = await request(`http://127.0.0.1:${port}/__wsd/info`);
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
  // file at `${MOUNT_POINT}/repo/a.txt` into wsd's VFS over
  // capnweb, and the shim drops it on disk at the same absolute
  // path. The on-disk read is what proves the mountPoint plumbing
  // works — a regression would surface here as ENOENT.
  const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
  const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
  const { createWorkspaceClient } = await import("@cloudflare/workspace-rpc/client");
  const { pushOnce } = await import("@cloudflare/workspace-rpc/driver");

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-shim-push-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "shim" } });

  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/ws` });
  onTestFinished(() => client.close());

  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, Date.now);
  const fsFacade = new WorkspaceFilesystem(db);
  await fsFacade.mkdir(`${mountPoint}/repo`, { recursive: true });
  await fsFacade.writeFile(`${mountPoint}/repo/a.txt`, "alpha");

  // The exact rev count depends on how many ancestor directories
  // mkdir(recursive) had to materialise under the tmpdir mount
  // point. The on-disk assertion below is the real contract.
  expect(await pushOnce(db, client.sync)).toBeGreaterThan(0);

  expect(await fs.readFile(path.join(mountPoint, "repo", "a.txt"), "utf8")).toBe("alpha");
});

test("wsd rejects unknown FUSE_MOUNT values", async () => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/wsd-mount-not-used",
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
])("wsd refuses to boot when legacy %s is set", async (name, value) => {
  const port = await getAvailablePort();
  const child = spawn(cliPath, {
    cwd: packageRoot,
    env: {
      ...process.env,
      MOUNT_POINT: "/tmp/wsd-mount-not-used",
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
  // running wsd. wsd must close the previous outbound socket before
  // opening the new one — otherwise the old session leaks for the
  // life of the container and the DO ends up with two halves of two
  // sessions tangled together.
  const { WebSocketServer } = await import("ws");
  const peerPort = await getAvailablePort();
  const opened = [];
  const peerSockets = new Set();
  const peerServer = http.createServer((req, res) => {
    if (req.url === "/health") {
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
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
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
        // can return; otherwise an unkilled wsd-side WS keeps the
        // server open and the test hangs at teardown.
        for (const sock of peerSockets) sock.destroy();
        wss.close();
        peerServer.close(() => resolve());
      }),
  );

  const port = await getAvailablePort();
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "wsd-mount-"));
  await startWsd({ port, mountPoint, env: { FUSE_MOUNT: "none" } });

  const peerUrl = `http://127.0.0.1:${peerPort}`;
  const connect = async () => {
    const res = await postJson(`http://127.0.0.1:${port}/connect`, { url: peerUrl });
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
});

async function startWsd({
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
      reject(new Error("timed out waiting for wsd to exit"));
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
      throw new Error(`wsd exited before becoming ready: ${child.exitCode}\n${output()}`);
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

function request(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
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

function postJson(url, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
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
      reject(new Error("timed out waiting for wsd to exit"));
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}
