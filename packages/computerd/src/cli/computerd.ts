#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { ExecEvent as RpcExecEvent } from "@cloudflare/computer-rpc";
import { isStubTrackingEnabled, stubSnapshot } from "@cloudflare/computer-rpc/debug";
import type { RunnerLike } from "@cloudflare/computer-rpc/server";
import {
  acceptWebSocketSession,
  createWorkspaceServer,
  serveHTTPBatch,
} from "@cloudflare/computer-rpc/server";
import type { Database } from "@cloudflare/dofs";
import { WebSocket, WebSocketServer } from "ws";
import { Runner } from "../exec/index.js";
import type { ExecEvent as ComputerdExecEvent } from "../exec/types.js";
import {
  createNodeVirtualFileSystem,
  type FUSEBackend,
  type FuseMount,
  mountFuse,
  parseFuseMountMode,
  resolveFuseBackend,
} from "../fuse/index.js";
import { mountShim, type ShimMount } from "../shim/index.js";
import { installLogging } from "./logger.js";

// The compiled-in default port. esbuild's `define` substitutes the
// real value at SEA bundle time when COMPUTERD_DEFAULT_PORT is set on
// the build host; tsc-only builds keep the literal 45678 below.
// Runtime `PORT` env still wins over this default.
declare const __COMPUTERD_BUILD_DEFAULT_PORT__: number | undefined;
const BUILD_DEFAULT_PORT: number | undefined =
  typeof __COMPUTERD_BUILD_DEFAULT_PORT__ === "number"
    ? __COMPUTERD_BUILD_DEFAULT_PORT__
    : undefined;
const DEFAULT_PORT = BUILD_DEFAULT_PORT ?? 45678;
const DEFAULT_MOUNT_POINT = "/workspace";
const HOST = "0.0.0.0";

// The previous boot path used three separate env vars to pick a
// FUSE backend (DISABLE_FUSE, FUSE_SHIM, WSD_FUSE_BACKEND). They
// were collapsed into a single FUSE_MOUNT knob. We're pre-1.0 alpha
// with no production consumers, so refuse to boot on the old vars
// rather than silently translating — the operator should learn the
// new name once.
const LEGACY_FUSE_ENV_MIGRATION: Record<string, string> = {
  DISABLE_FUSE: "FUSE_MOUNT=none",
  FUSE_SHIM: "FUSE_MOUNT=shim",
  WSD_FUSE_BACKEND: "FUSE_MOUNT=fuse (linux) or FUSE_MOUNT=macfuse (darwin)",
};

function rejectLegacyFuseEnv(env: NodeJS.ProcessEnv): void {
  for (const [name, replacement] of Object.entries(LEGACY_FUSE_ENV_MIGRATION)) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      throw new Error(
        `${name} is no longer supported; use ${replacement} instead (FUSE_MOUNT defaults to auto)`,
      );
    }
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(value)}`);
  }

  return port;
}

function parseMountPoint(value: string | undefined): string {
  const mountPoint = value === undefined || value === "" ? DEFAULT_MOUNT_POINT : value;
  if (!isAbsolute(mountPoint)) {
    throw new Error(`MOUNT_POINT must be an absolute path, got ${JSON.stringify(value)}`);
  }

  return mountPoint;
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname;
}

// Strip heartbeat events from a Runner stream before it reaches the
// RPC layer. Heartbeats are a local observability signal only; the
// computer-rpc wire contract carries only stdout, stderr, and exit.
function dropHeartbeats(stream: ReadableStream<ComputerdExecEvent>): ReadableStream<RpcExecEvent> {
  return stream.pipeThrough(
    new TransformStream<ComputerdExecEvent, RpcExecEvent>({
      transform(event, controller) {
        if (event.name !== "heartbeat") {
          controller.enqueue(event as RpcExecEvent);
        }
      },
    }),
  );
}

interface ComputerdInfo {
  backend: FUSEBackend;
  mountPoint: string;
  port: number;
}

// Snapshot DOFS table sizes and process memory so an external caller
// can watch growth without attaching a debugger. Used by the
// /__computerd/stats endpoint while diagnosing the npm install OOM.
function collectDbStats(db: Database): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: small ad-hoc shape
  const out: Record<string, any> = {};
  try {
    out.vfs_nodes_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_nodes") ?? 0;
    out.vfs_dirents_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents") ?? 0;
    out.vfs_chunks_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_chunks") ?? 0;
    out.vfs_blobs_count = db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
    out.vfs_blob_bytes_total =
      db.scalar<number>("SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM vfs_blob_bytes") ?? 0;
    out.vfs_blobs_orphan =
      db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_blobs b WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)",
      ) ?? 0;
    out.vfs_blob_bytes_orphan =
      db.scalar<number>(
        "SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM vfs_blob_bytes bb WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = bb.hash)",
      ) ?? 0;
  } catch (error) {
    out.error = (error as Error).message;
  }
  const mem = process.memoryUsage();
  out.rss = mem.rss;
  out.heap_used = mem.heapUsed;
  out.heap_total = mem.heapTotal;
  out.external = mem.external;
  out.array_buffers = mem.arrayBuffers;
  return out;
}

interface HTTPHandle {
  server: Server;
  // Tear down the WebSocketServer alongside the HTTP server.
  close: () => Promise<void>;
}

function createHTTPServer(
  info: ComputerdInfo,
  rpc: ReturnType<typeof createWorkspaceServer>,
  getStats?: () => Record<string, unknown>,
): HTTPHandle {
  // Holds the current outbound capnweb session opened via /connect.
  // Re-POSTing /connect (e.g. after a DO hibernate + new incarnation)
  // closes the previous socket so the old session doesn't leak for
  // the life of the container.
  const upstreamSlot: { ws: WebSocket | undefined } = { ws: undefined };
  const server = createServer((request, response) => {
    const path = requestPath(request);

    // /api — capnweb HTTP-batch endpoint. Single POST per call;
    // request body carries the serialized message, response body
    // carries the reply. Useful for environments that can't open
    // a WebSocket (curl, fetch from a Worker without ws upgrade).
    if (path === "/api") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      void serveHTTPBatch(request, response, rpc).catch((error) => {
        console.error("/api batch failed:", error);
        if (!response.headersSent) {
          send(response, 500, "internal error\n", {
            "content-type": "text/plain; charset=utf-8",
          });
        }
      });
      return;
    }

    // /connect — POST { url } where url is the http(s) base of an
    // egress endpoint the host wants us to dial back into. We open a
    // capnweb WebSocket session against `${url}/ws` and serve our RPC
    // over it, exactly like /ws but with the carrier inverted (we
    // dial out instead of accepting an inbound upgrade).
    if (path === "/connect") {
      if (request.method !== "POST") {
        send(response, 405, "method not allowed\n", {
          allow: "POST",
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      void handleConnect(request, response, rpc, upstreamSlot);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "method not allowed\n", {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/health") {
      const body = request.method === "HEAD" ? "" : "ok\n";
      send(response, 200, body, {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/stubs") {
      if (!isStubTrackingEnabled()) {
        send(response, 404, "stub tracking disabled (set CAPNWEB_TRACK_STUBS=1)\n", {
          "content-type": "text/plain; charset=utf-8",
        });
        return;
      }
      const body = request.method === "HEAD" ? "" : JSON.stringify(stubSnapshot());
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/stats") {
      const stats = getStats?.() ?? {};
      const body = request.method === "HEAD" ? "" : JSON.stringify(stats);
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/__computerd/info") {
      const body = request.method === "HEAD" ? "" : JSON.stringify(info);
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    if (path === "/") {
      const body = request.method === "HEAD" ? "" : "{}";
      send(response, 200, body, {
        "content-type": "application/json; charset=utf-8",
      });
      return;
    }

    send(response, 404, "not found\n", {
      "content-type": "text/plain; charset=utf-8",
    });
  });

  // /ws — capnweb WebSocket endpoint. Long-lived, bidirectional,
  // streaming-friendly. The container's primary sync carrier.
  // perMessageDeflate compresses each WS frame with zlib. Defaults
  // off in the `ws` package; we turn it on so computerd-to-computerd peers
  // (and any Node-side client that negotiates the extension) save
  // bytes on the wire. Clients that don't advertise the extension
  // negotiate down to plain frames, so no flag day for workerd or
  // browser callers.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  server.on("upgrade", (request, socket, head) => {
    if (requestPath(request) !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

interface ConnectBody {
  // Base URL of the egress endpoint. ws[s]:// or http[s]://; we
  // normalise http(s) to ws(s) and append /ws.
  url?: unknown;
  // How long to poll the upstream /health before giving up.
  // Defaults to 30s; the egress proxy is up at boot but the worker
  // that hosts it may take a tick.
  healthTimeoutMs?: unknown;
}

async function handleConnect(
  request: IncomingMessage,
  response: ServerResponse,
  rpc: ReturnType<typeof createWorkspaceServer>,
  upstreamSlot: { ws: WebSocket | undefined },
): Promise<void> {
  let body: ConnectBody;
  try {
    body = await readJson<ConnectBody>(request);
  } catch (error) {
    send(response, 400, `invalid JSON body: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (typeof body.url !== "string" || body.url.length === 0) {
    send(response, 400, "missing 'url' in body\n", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }
  const baseUrl = body.url.replace(/\/+$/, "");
  const healthTimeoutMs =
    typeof body.healthTimeoutMs === "number" && body.healthTimeoutMs > 0
      ? body.healthTimeoutMs
      : 30_000;

  try {
    await waitForHealth(baseUrl, healthTimeoutMs);
  } catch (error) {
    send(response, 502, `upstream /health unreachable: ${(error as Error).message}\n`, {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  // Close any prior outbound session before opening a new one. A DO
  // restart / hibernate hands the new incarnation a fresh /connect;
  // without this, the previous WebSocket leaks for the life of the
  // container.
  const previous = upstreamSlot.ws;
  if (previous !== undefined) {
    upstreamSlot.ws = undefined;
    try {
      previous.close(1000, "replaced by new /connect");
    } catch {
      // already closed; idempotent
    }
  }

  const wsUrl = `${toWebSocketUrl(baseUrl)}/ws`;
  const ws = new WebSocket(wsUrl);
  upstreamSlot.ws = ws;
  ws.once("open", () => {
    console.log(`/connect: attached RPC session to ${wsUrl}`);
    acceptWebSocketSession(ws, rpc);
  });
  ws.once("close", () => {
    // Drop the slot only if we're still the current ws — a
    // subsequent /connect may have already installed a new one.
    if (upstreamSlot.ws === ws) upstreamSlot.ws = undefined;
  });
  ws.once("error", (err) => {
    console.error(`/connect: WebSocket error against ${wsUrl}:`, err.message);
  });
  send(response, 200, `${JSON.stringify({ ok: true, ws: wsUrl })}\n`, {
    "content-type": "application/json; charset=utf-8",
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {} as T;
  return JSON.parse(text) as T;
}

function toWebSocketUrl(input: string): string {
  if (input.startsWith("ws://") || input.startsWith("wss://")) return input;
  if (input.startsWith("http://")) return `ws://${input.slice("http://".length)}`;
  if (input.startsWith("https://")) return `wss://${input.slice("https://".length)}`;
  throw new Error(`unsupported URL scheme: ${input}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${toHttpUrl(baseUrl)}/health`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${healthUrl} not healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function toHttpUrl(input: string): string {
  if (input.startsWith("ws://")) return `http://${input.slice("ws://".length)}`;
  if (input.startsWith("wss://")) return `https://${input.slice("wss://".length)}`;
  return input;
}

async function main(): Promise<void> {
  // Install logging + crash handlers first thing so any early throws
  // (parsePort, parseMountPoint, resolveFuseBackend) still land in
  // LOG_FILE when set.
  const teardownLogging = installLogging(process.env.LOG_FILE);

  rejectLegacyFuseEnv(process.env);

  const port = parsePort(process.env.PORT);
  const mountPoint = parseMountPoint(process.env.MOUNT_POINT);
  // FUSE_MOUNT picks the backend. auto (default) probes /dev/fuse
  // or macFUSE and falls back to the userspace shim. fuse / macfuse
  // require their respective real backend. shim forces the userspace
  // polling shim. none skips the mount entirely; HTTP + /api + /ws
  // still come up so tests and tooling can talk to computerd's RPC surface.
  const fuseMountMode = parseFuseMountMode(process.env.FUSE_MOUNT);
  const backend: FUSEBackend = await resolveFuseBackend(fuseMountMode);
  console.log(`[info] FUSE_MOUNT=${fuseMountMode} resolved to backend=${backend.kind}`);

  const { vfs, db } = await createNodeVirtualFileSystem();
  const info: ComputerdInfo = { backend, mountPoint, port };

  let fuse: FuseMount | undefined;
  // When running on the userspace shim, capture the typed handle
  // so we can wire `flush()` and `reconcileNow()` into the SyncRPC
  // afterApply / beforeFetch hooks below. A real FUSE mount serves
  // reads straight from the VFS, so it doesn't need either settle.
  let shim: ShimMount | undefined;
  if (backend.kind !== "none") {
    // The VFS stores everything under `mountPoint` so capnweb pulls,
    // shim materialisation, and shell `exec` agree on absolute
    // paths. Pre-create the mount directory in the VFS so FUSE's
    // first getattr on "/" can stat the mount root.
    vfs.mkdirSync(mountPoint, { recursive: true });
    await mkdir(mountPoint, { recursive: true });

    if (backend.kind === "shim") {
      shim = await mountShim({ vfs, mountPoint });
      fuse = shim;
    } else {
      fuse = await mountFuse({
        backend,
        mountPoint,
        vfs,
      });
    }
  }
  // EXEC_LOG_MAX_BYTES lets the harness force size-cap eviction
  // without rebuilding the binary. Default lives in the Runner.
  const logMaxBytesEnv = process.env.EXEC_LOG_MAX_BYTES;
  let logMaxBytesOverride: number | undefined;
  if (logMaxBytesEnv !== undefined && logMaxBytesEnv !== "") {
    const parsed = Number(logMaxBytesEnv);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(
        `EXEC_LOG_MAX_BYTES must be a positive integer; got ${JSON.stringify(logMaxBytesEnv)}`,
      );
    }
    logMaxBytesOverride = parsed;
  }
  const runner = new Runner({
    db,
    // When we have a mount (real FUSE or the shim) point spawned
    // children at it so writes from exec flow through the VFS.
    ...(fuse !== undefined ? { cwd: mountPoint } : {}),
    ...(logMaxBytesOverride !== undefined ? { logMaxBytes: logMaxBytesOverride } : {}),
  });
  // Heartbeat events are computerd-local and must not cross the RPC boundary.
  // Wrap the runner so every exec/get stream drops heartbeat events before
  // they reach the wire. RunnerLike expects only stdout, stderr, and exit.
  const rpcRunner: RunnerLike = {
    exec(command, options) {
      const handle = runner.exec(command, options);
      return { id: handle.id, events: dropHeartbeats(handle.events) };
    },
    get(id, options) {
      const handle = runner.get(id, options);
      return { id: handle.id, events: dropHeartbeats(handle.events) };
    },
    kill: runner.kill.bind(runner),
    dispose: runner.dispose.bind(runner),
  };
  const rpc = createWorkspaceServer(db, rpcRunner, {
    // Push handler awaits the shim flush before returning, so any
    // exec()/read against the host fs after a push sees the new
    // files. Real FUSE doesn't need this — the kernel-FUSE driver
    // serves reads from the VFS directly.
    // Symmetric shim settles:
    //   - afterApply (push side): wait for the VFS→disk flush so
    //     a subsequent `shell.exec` sees the just-pushed files.
    //   - beforeFetch (pull side): wait for the disk→VFS reconcile
    //     so a `Workspace.pull()` issued right after `shell.exec`
    //     observes files the exec'd process just wrote, without
    //     waiting on the next periodic poll tick.
    ...(shim
      ? {
          afterApply: () => shim.flush(),
          beforeFetch: () => shim.reconcileNow(),
        }
      : {}),
  });
  const http = createHTTPServer(info, rpc, () => ({
    ...collectDbStats(db),
    ...(fuse?.getBufferStats?.() ?? {}),
  }));

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await http.close();
    } catch (error) {
      console.error(error);
    }
    try {
      runner.disposeAll();
    } catch (error) {
      console.error(error);
    }

    if (fuse !== undefined) {
      await unmount(fuse);
    }
    teardownLogging();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", (signal) => void shutdown(signal));
  process.once("SIGTERM", (signal) => void shutdown(signal));

  await new Promise<void>((resolve) => {
    http.server.listen(port, HOST, () => {
      const address = http.server.address();

      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      info.port = boundPort;
      const mountLabel = backend.kind === "none" ? "(disabled)" : mountPoint;
      console.log(
        `computerd listening on ${HOST}:${boundPort} mount=${mountLabel} backend=${backend.kind}`,
      );
      resolve();
    });
  });
}

async function unmount(fuse: FuseMount): Promise<void> {
  try {
    await fuse.unmount();
  } catch (error) {
    console.error("failed to unmount FUSE:", error instanceof Error ? error.message : error);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
