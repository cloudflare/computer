#!/usr/bin/env node

// computerd-stub-soak.mjs — soak the long-lived WebSocket session against a
// running computerd and watch two signals:
//
//   1. capnweb session stats. We construct the client-side RpcSession
//      ourselves (using the same WebSocketTransport shape capnweb's
//      newWebSocketRpcSession uses) so we can call session.getStats()
//      between phases. Stats are { imports, exports } — entries in the
//      session's stub tables. Unbounded growth there is the leak.
//
//   2. Our per-class RpcTarget counter (GET /__computerd/stubs). Less precise
//      but catches leaks in our own code rather than capnweb's tables.
//
// Workload (defaults — override via env):
//
//   SOAK_SYNC_TICKS    hasObjects calls            (default 50)
//   SOAK_FETCH_CALLS   fetchChanges calls          (default 50)
//   SOAK_EXEC_CALLS    shell.exec calls            (default 100)
//   SOAK_QUIET_MS      idle window before final sample (default 500)
//
// Output: human progress on stderr, JSON summary on stdout.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { RpcSession } from "capnweb";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const COMPUTERD_BINARY =
  process.env.COMPUTERD_BINARY ?? join(REPO_ROOT, "packages/computerd/dist/cli/computerd.cjs");

const SYNC_TICKS = Number(process.env.SOAK_SYNC_TICKS ?? "50");
const EXEC_CALLS = Number(process.env.SOAK_EXEC_CALLS ?? "100");
const FETCH_CALLS = Number(process.env.SOAK_FETCH_CALLS ?? "50");
const QUIET_MS = Number(process.env.SOAK_QUIET_MS ?? "500");

// ───────────────────────────────────────────────────────────────────
// WebSocketTransport, ported from capnweb/src/websocket.ts. We need
// to instantiate RpcSession ourselves so we can read getStats(); the
// public newWebSocketRpcSession() helper discards the session object.

class WebSocketTransport {
  constructor(webSocket) {
    this._ws = webSocket;
    this._sendQueue = [];
    this._receiveQueue = [];
    this._receiveResolver = undefined;
    this._receiveRejecter = undefined;
    this._error = undefined;
    this._opened = webSocket.readyState === WebSocket.OPEN;

    if (!this._opened) {
      webSocket.addEventListener("open", () => {
        try {
          for (const m of this._sendQueue) webSocket.send(m);
        } catch (err) {
          this._receivedError(err);
        }
        this._sendQueue = undefined;
        this._opened = true;
      });
    } else {
      this._sendQueue = undefined;
    }

    webSocket.addEventListener("message", (event) => {
      if (this._error) return;
      const data = typeof event.data === "string" ? event.data : event.data?.toString("utf8");
      if (typeof data !== "string") {
        this._receivedError(new TypeError("non-string ws message"));
        return;
      }
      if (this._receiveResolver) {
        const r = this._receiveResolver;
        this._receiveResolver = undefined;
        this._receiveRejecter = undefined;
        r(data);
      } else {
        this._receiveQueue.push(data);
      }
    });

    webSocket.addEventListener("close", (event) => {
      this._receivedError(new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`));
    });
    webSocket.addEventListener("error", () => {
      this._receivedError(new Error("WebSocket connection failed."));
    });
  }

  async send(message) {
    if (this._sendQueue !== undefined) this._sendQueue.push(message);
    else this._ws.send(message);
  }

  async receive() {
    if (this._receiveQueue.length > 0) return this._receiveQueue.shift();
    if (this._error) throw this._error;
    return new Promise((res, rej) => {
      this._receiveResolver = res;
      this._receiveRejecter = rej;
    });
  }

  abort(reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    try {
      this._ws.close(3000, message);
    } catch {}
    if (!this._error) this._error = reason;
  }

  _receivedError(reason) {
    if (this._error) return;
    this._error = reason;
    if (this._receiveRejecter) {
      const r = this._receiveRejecter;
      this._receiveResolver = undefined;
      this._receiveRejecter = undefined;
      r(reason);
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// HTTP helpers

function getAvailablePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

function httpGet(url) {
  return new Promise((res, rej) => {
    const req = request(url, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => {
        body += c;
      });
      r.on("end", () => res({ statusCode: r.statusCode ?? 0, body }));
    });
    req.once("error", rej);
    req.end();
  });
}

async function waitForHealth(port, child, deadlineMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (child.exitCode !== null) {
      throw new Error(`computerd exited early with code ${child.exitCode}`);
    }
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/health`);
      if (r.statusCode === 200) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("computerd never reported healthy");
}

async function targetSnapshot(port) {
  const r = await httpGet(`http://127.0.0.1:${port}/__computerd/stubs`);
  if (r.statusCode !== 200) {
    throw new Error(`/__computerd/stubs returned ${r.statusCode}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

// ───────────────────────────────────────────────────────────────────
// Main

async function main() {
  const port = await getAvailablePort();
  const mountPoint = await mkdtemp(join(tmpdir(), "computerd-stub-soak-"));

  const env = {
    ...process.env,
    MOUNT_POINT: mountPoint,
    PORT: String(port),
    FUSE_MOUNT: "none",
    CAPNWEB_TRACK_STUBS: "1",
  };

  console.error(`[soak] starting computerd on :${port} (mount=${mountPoint})`);
  const child = spawn(COMPUTERD_BINARY, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderrBuf += c;
  });
  child.stdout.resume();

  const cleanup = async () => {
    try {
      child.kill("SIGTERM");
      await sleep(150);
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {}
    await rm(mountPoint, { recursive: true, force: true });
  };

  const phases = []; // { label, sessionStats, targets }
  async function sample(session, label) {
    const sessionStats = session.getStats();
    const targets = await targetSnapshot(port);
    phases.push({ label, sessionStats, targets });
    console.error(
      `[soak] ${label.padEnd(22)} imports=${sessionStats.imports} exports=${sessionStats.exports}  targets=${JSON.stringify(targets)}`,
    );
  }

  try {
    await waitForHealth(port, child);
    console.error("[soak] computerd healthy");

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const transport = new WebSocketTransport(ws);
    const session = new RpcSession(transport);
    const stub = session.getRemoteMain();

    await sample(session, "afterConnect");

    // Warm a watermarks call so any first-touch lazy-init lands before
    // we start sampling deltas.
    await stub.sync.watermarks();
    await sample(session, "afterFirstCall");

    // Phase 1: pure-value calls. No stub envelopes in the response, so
    // exports/imports shouldn't move.
    console.error(`[soak] ${SYNC_TICKS} hasObjects calls…`);
    for (let i = 0; i < SYNC_TICKS; i++) {
      await stub.sync.hasObjects([]);
    }
    await sample(session, "afterHasObjects");

    // Phase 2: fetchChanges. Returns { currentRev, appliedPushRev, stream }.
    // The stream is an RpcStream-ish object — capnweb tracks it in the
    // exports table. We drain it but DO NOT dispose the envelope.
    console.error(`[soak] ${FETCH_CALLS} fetchChanges calls (no disposal)…`);
    for (let i = 0; i < FETCH_CALLS; i++) {
      const result = await stub.sync.fetchChanges({ sinceRev: 0, ignore: [] });
      const reader = result.stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
      // intentionally NOT disposing result
    }
    await sample(session, "afterFetchChanges");

    // Phase 3: exec. Returns { id, events }. Same drain-but-don't-dispose
    // pattern as fetchChanges.
    console.error(`[soak] ${EXEC_CALLS} exec calls (no disposal)…`);
    for (let i = 0; i < EXEC_CALLS; i++) {
      const result = await stub.shell.exec({ source: "true" });
      const reader = result.events.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await sample(session, "afterExec");

    // Phase 4: idle quiet window. Anything deferred (post-call dispose
    // ticks) should fire here.
    await sleep(QUIET_MS);
    await sample(session, "afterQuiet");

    // Phase 5: now DO dispose the envelopes — repeat fetchChanges with
    // [Symbol.dispose]() at the end. If exports stays flat across both
    // phases, capnweb is auto-disposing; if it only stays flat here,
    // we know the call sites need explicit disposal.
    console.error(`[soak] ${FETCH_CALLS} fetchChanges calls (with disposal)…`);
    for (let i = 0; i < FETCH_CALLS; i++) {
      const result = await stub.sync.fetchChanges({ sinceRev: 0, ignore: [] });
      const reader = result.stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
      result[Symbol.dispose]?.();
    }
    await sleep(QUIET_MS);
    await sample(session, "afterFetchDisposed");

    console.error(`[soak] ${EXEC_CALLS} exec calls (with disposal)…`);
    for (let i = 0; i < EXEC_CALLS; i++) {
      const result = await stub.shell.exec({ source: "true" });
      const reader = result.events.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
      result[Symbol.dispose]?.();
    }
    await sleep(QUIET_MS);
    await sample(session, "afterExecDisposed");

    // Close root stub + socket.
    stub[Symbol.dispose]?.();
    ws.close();
    await sleep(QUIET_MS);

    // ─── Summary ────────────────────────────────────────────────
    const baselineExports = phases[1].sessionStats.exports; // afterFirstCall
    const baselineImports = phases[1].sessionStats.imports;

    const summary = {
      config: { SYNC_TICKS, EXEC_CALLS, FETCH_CALLS, QUIET_MS },
      phases,
      growth: phases.map((p) => ({
        label: p.label,
        imports: p.sessionStats.imports - baselineImports,
        exports: p.sessionStats.exports - baselineExports,
      })),
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    console.error("\n[soak] growth vs afterFirstCall:");
    for (const g of summary.growth) {
      const tag =
        g.imports === 0 && g.exports === 0 ? "  " : g.imports > 0 || g.exports > 0 ? "↑ " : "↓ ";
      console.error(
        `  ${tag}${g.label.padEnd(22)} Δimports=${String(g.imports).padStart(4)}  Δexports=${String(g.exports).padStart(4)}`,
      );
    }
  } finally {
    await cleanup();
    if (process.env.SOAK_DUMP_COMPUTERD_STDERR === "1") {
      process.stderr.write(`\n--- computerd stderr ---\n${stderrBuf}`);
    }
  }
}

main().catch((err) => {
  console.error("[soak] failed:", err);
  process.exit(1);
});
