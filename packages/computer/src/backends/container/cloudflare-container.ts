// CloudflareContainerBackend — backs Workspace with a computerd instance
// running inside a Cloudflare Container.
//
// The backend drives container lifecycle through an IWorkspaceContainerAPI
// abstraction. Same-DO and cross-DO callers look identical from
// here; whether ctx.container is reached directly or through an
// RPC stub is a concern of the IWorkspaceContainerAPI implementation.
//
// Same-DO shape (one DO owns both the container and the Workspace):
//
//   class ComputerdContainer extends DurableObject<Env> {
//     #backend = new CloudflareContainerBackend({
//       container: () => this.ws,
//       workspace: { binding: "ComputerdContainer", id: this.ctx.id.toString() },
//     });
//     #workspace = new Workspace({ backends: [this.#backend] });
//
//     override fetch(req: Request): Promise<Response> {
//       return this.#backend.handleFetch(req);
//     }
//   }
//
// Cross-DO shape (Agent DO holds the Workspace, a pool member DO
// owns the container):
//
//   class AgentDO extends DurableObject<Env> {
//     #backend = new CloudflareContainerBackend({
//       container: async () => {
//         const memberId = await pickPoolMember(this.env, this.ctx.id);
//         return this.env.ComputerdHost.get(this.env.ComputerdHost.idFromString(memberId));
//       },
//       workspace: { binding: "AgentDO", id: this.ctx.id.toString() },
//     });
//   }
//
// The factory runs once per connect(), so a redial after a session
// drop re-picks the pool member; mid-session container churn is the
// pool's problem, not the backend's.
//
// Failure model: connect() does the bootstrap once and throws on
// any failure. The Workspace's ready() retries by re-entering
// connect() on the next call. On a mid-session WebSocket drop the
// backend resolves `BackendHandle.closed`, which the Workspace
// listens for and uses to drop its cached handle so the next call
// rebuilds against a fresh session.

import type { WorkspaceRPC } from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { startHeartbeat } from "../../heartbeat.js";
import {
  WORKSPACE_EGRESS_TOKEN_HEADER,
  WORKSPACE_EGRESS_URL_HEADER,
  type WorkspaceEgressPolicy,
} from "../../runtime/egress.js";
import { WorkspaceTransportError } from "../../transport-failure.js";
import type { IWorkspaceContainerAPI, WorkspaceRef } from "./container-host.js";
import { probeComputerdHealth } from "./health-probe.js";

// What the backend's `container` factory returns: anything with
// a getWorkspaceContainer() method — the shape withWorkspaceContainer
// installs. Same-DO callers pass `this`; cross-DO callers pass a
// DO stub whose target was extended with withWorkspaceContainer
// (Workers RPC exposes the method as a pipelined callable).
export interface ContainerHostHolder {
  getWorkspaceContainer(): IWorkspaceContainerAPI | Promise<IWorkspaceContainerAPI>;
}

export interface CloudflareContainerBackendOptions {
  // Resolves the container host to drive on each connect(). Called
  // anew per dial so a pool-backed factory can re-pick. Returning
  // a Promise is supported for pickers that consult external state
  // (KV, a coordinator DO, etc.).
  //
  // The returned value exposes getWorkspaceContainer() — the same
  // shape withWorkspaceContainer installs. Pass `this` (same-DO)
  // or a DO stub (cross-DO); the backend calls the method itself.
  container: () => ContainerHostHolder | Promise<ContainerHostHolder>;

  // Identifies the Workspace-owning DO. Fixed for the lifetime of
  // the backend: the backend lives inside this DO and the /ws
  // upgrade always lands here. Plain {binding, id} data so it
  // survives the Workers RPC hop to a cross-DO container host.
  workspace: WorkspaceRef;

  // Hostname computerd will dial back. Defaults to "computer.internal".
  // Override for tests or to avoid collisions with other backends
  // sharing the same container host.
  egressHost?: string;

  egress?: WorkspaceEgressPolicy;

  // TCP port computerd listens on inside the container. Default 8080,
  // matching the Dockerfile shipped with examples/container.
  containerPort?: number;

  // Environment variables passed to container.start(). Merged onto
  // the defaults (PORT, MOUNT_POINT). Caller-supplied values win.
  containerEnv?: Record<string, string>;

  // Total time the backend waits for: container port to open,
  // /connect POST to return, /ws upgrade to arrive. Default 30s.
  connectTimeoutMs?: number;

  // Period for the application-level heartbeat — a watermarks()
  // RPC on a timer. Two jobs: detect a silently-dead peer faster
  // than waiting for the next real RPC, and keep middlebox idle
  // timers warm. Default 20_000ms. Set 0 to disable.
  heartbeatIntervalMs?: number;

  // Number of forced restart attempts after startup readiness
  // fails. The first attempt runs host.start() then probes computerd;
  // each restart attempt runs host.restart() then probes computerd
  // again. Defaults to 1 (one restart after the initial start).
  // Set 0 to disable restart on failed readiness.
  restartAttempts?: number;

  // Per-probe timeout for the startup health probe. Defaults to
  // 2 seconds. The shared probeComputerdHealth helper aborts the request
  // when it elapses; the next probe in the loop carries the
  // remaining readiness budget.
  healthProbeTimeoutMs?: number;

  // First retry delay after a failed startup probe. Defaults to
  // 250ms. Subsequent failures double the prior delay, capped at
  // healthRetryMaxDelayMs.
  healthRetryInitialDelayMs?: number;

  // Maximum delay between failed startup probes. Defaults to 2s.
  healthRetryMaxDelayMs?: number;

  // Selector this backend is registered under in Workspace.
  // Defaults to "container-shell"; override when the
  // workspace hosts more than one instance of the same backend
  // kind (e.g. two containers pinned to different pool members).
  id?: string;
}

const DEFAULT_EGRESS_HOST = "computer.internal";
const DEFAULT_CONTAINER_PORT = 8080;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_RESTART_ATTEMPTS = 1;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_HEALTH_RETRY_INITIAL_DELAY_MS = 250;
const DEFAULT_HEALTH_RETRY_MAX_DELAY_MS = 2_000;

export class CloudflareContainerBackend implements WorkspaceBackend {
  readonly type = "cloudflare-container";
  readonly id: string;

  readonly #options: Required<
    Omit<
      CloudflareContainerBackendOptions,
      "container" | "workspace" | "containerEnv" | "egress" | "id"
    >
  > &
    Pick<CloudflareContainerBackendOptions, "container" | "workspace" | "containerEnv">;
  readonly #egress: WorkspaceEgressPolicy;
  readonly #egressToken: string | undefined;

  // State for the in-flight /ws upgrade. handleFetch() resolves
  // #pendingUpgrade; connect() awaits it.
  #pendingUpgrade: Promise<WebSocket> | undefined;
  #resolveUpgrade: ((ws: WebSocket) => void) | undefined;
  #rejectUpgrade: ((err: unknown) => void) | undefined;

  // Cached after the first successful connect(). Cleared on close()
  // or when the underlying WebSocket reports `close` / `error`.
  #handle: BackendHandle | undefined;

  constructor(options: CloudflareContainerBackendOptions) {
    this.id = options.id ?? "container-shell";
    this.#egress = options.egress ?? { mode: "none" };
    this.#egressToken = this.#egress.mode === "http-gateway" ? crypto.randomUUID() : undefined;
    this.#options = {
      container: options.container,
      workspace: options.workspace,
      containerEnv: options.containerEnv,
      egressHost: options.egressHost ?? DEFAULT_EGRESS_HOST,
      containerPort: options.containerPort ?? DEFAULT_CONTAINER_PORT,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      restartAttempts: options.restartAttempts ?? DEFAULT_RESTART_ATTEMPTS,
      healthProbeTimeoutMs: options.healthProbeTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
      healthRetryInitialDelayMs:
        options.healthRetryInitialDelayMs ?? DEFAULT_HEALTH_RETRY_INITIAL_DELAY_MS,
      healthRetryMaxDelayMs: options.healthRetryMaxDelayMs ?? DEFAULT_HEALTH_RETRY_MAX_DELAY_MS,
    };
  }

  async connect(): Promise<BackendHandle> {
    if (this.#handle) return this.#handle;

    const deadline = Date.now() + this.#options.connectTimeoutMs;
    const holder = await this.#options.container();
    const host = await holder.getWorkspaceContainer();

    // Pre-flight: surface any prior container exit so a readiness
    // failure can attribute it back to the crash. host.start()
    // clears this once the new generation is up, so a successful
    // dial against a previously-dead container loses the
    // attribution — which is the right semantics; the prior exit
    // is only interesting if the new attempt fails too.
    const priorExit = await host.exitInfo().catch(() => null);

    const env = {
      PORT: String(this.#options.containerPort),
      MOUNT_POINT: "/workspace",
      ...this.#options.containerEnv,
    };
    let runtimeId: string;
    try {
      ({ runtimeId } = await host.start(env, this.#egress.mode === "direct"));
    } catch (error) {
      throw new WorkspaceTransportError(
        this.#formatStageError("start", {
          attempt: 1,
          maxAttempts: this.#options.restartAttempts + 1,
          restarts: 0,
          lastError: error,
          priorExit,
        }),
        { cause: error },
      );
    }
    try {
      await host.interceptOutboundHttp(this.#options.egressHost, this.#options.workspace);
      if (this.#egress.mode === "http-gateway" && this.#egressToken !== undefined) {
        await host.interceptAllOutboundHttp(this.#options.workspace, this.#egressToken);
      }
    } catch (error) {
      throw new WorkspaceTransportError(
        this.#formatStageError("egress", {
          attempt: 1,
          maxAttempts: this.#options.restartAttempts + 1,
          restarts: 0,
          lastError: error,
          priorExit,
        }),
        { cause: error },
      );
    }

    // Arm the upgrade promise before posting /connect — computerd
    // dials back as soon as /health on the egress answers, so
    // the upgrade can arrive before the POST resolves.
    this.#armUpgrade();

    runtimeId = await this.#readyWithRestarts(host, env, deadline, priorExit, runtimeId);
    await this.#postConnect(host, deadline);
    const ws = await this.#waitForUpgrade(deadline);

    const stub = newWebSocketRpcSession(
      ws as unknown as globalThis.WebSocket,
    ) as RpcStub<WorkspaceRPC>;

    // `closed` resolves on the first 'close' event from the underlying
    // WebSocket. The Workspace listens for it and drops its cached
    // handle so the next ready() call rebuilds against a fresh
    // session.
    let stopHeartbeat: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      let fired = false;
      const onClose = () => {
        if (fired) return;
        fired = true;
        stopHeartbeat?.();
        resolve();
        this.#handle = undefined;
      };
      ws.addEventListener("close", onClose, { once: true });
      // Some runtimes fire 'error' without a follow-up 'close' on
      // abrupt teardown; treat error as close too.
      ws.addEventListener("error", onClose, { once: true });
      // capnweb's RPC layer can notice the session is broken (an
      // abort frame, a malformed message) before the underlying
      // WebSocket fires close. onRpcBroken closes that gap so the
      // next ready() rebuilds against a fresh transport instead of
      // waiting on a heartbeat or the next real RPC to discover
      // the wedged session.
      (stub as unknown as { onRpcBroken: (cb: (err: unknown) => void) => void }).onRpcBroken(
        onClose,
      );
    });

    if (this.#options.heartbeatIntervalMs > 0) {
      stopHeartbeat = startHeartbeat({
        intervalMs: this.#options.heartbeatIntervalMs,
        ping: () => (stub as unknown as WorkspaceRPC).sync.watermarks(),
        onFailure: () => {
          try {
            ws.close();
          } catch {
            // already closed; idempotent
          }
        },
      });
    }

    const handle: BackendHandle = {
      rpc: stub as unknown as WorkspaceRPC,
      runtimeId,
      closed,
      close: async () => {
        stopHeartbeat?.();
        // Dispose the root stub first. Per capnweb's docs, this is
        // the documented way to shut a session down — it lets the
        // RPC layer send a clean abort frame to the peer before
        // the socket dies. Falling through to ws.close() is
        // belt-and-braces for runtimes where the dispose path
        // doesn't (yet) close the transport.
        try {
          (stub as unknown as Disposable)[Symbol.dispose]?.();
        } catch {
          // already disposed; idempotent
        }
        try {
          ws.close();
        } catch {
          // already closed; idempotent
        }
        this.#handle = undefined;
      },
    };
    this.#handle = handle;
    return handle;
  }

  // Routes a /ws upgrade Request into the in-flight connect().
  // Returns the 101 response that the WorkspaceProxy fetch handler
  // forwards back to the container.
  async handleFetch(req: Request): Promise<Response> {
    if (
      this.#egress.mode === "http-gateway" &&
      this.#egressToken !== undefined &&
      req.headers.get(WORKSPACE_EGRESS_TOKEN_HEADER) === this.#egressToken
    ) {
      const headers = new Headers(req.headers);
      const originalUrl = headers.get(WORKSPACE_EGRESS_URL_HEADER);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(originalUrl ?? "");
      } catch {
        return new Response("invalid egress URL", { status: 400 });
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return new Response("invalid egress URL", { status: 400 });
      }
      headers.delete(WORKSPACE_EGRESS_TOKEN_HEADER);
      headers.delete(WORKSPACE_EGRESS_URL_HEADER);
      const sanitized = new Request(req, { headers });
      return this.#egress.gateway.fetch(new Request(parsedUrl, sanitized));
    }
    const url = new URL(req.url);
    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    if (this.#resolveUpgrade) {
      this.#resolveUpgrade(server);
    } else {
      // No connect() in flight — close the socket immediately.
      // The remote will redial on its next attempt; we don't
      // hold orphaned sockets that nothing will reap.
      server.close(1011, "no pending connect");
      return new Response("no pending connect", { status: 409 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- internals --------------------------------------------------

  #armUpgrade(): void {
    this.#pendingUpgrade = new Promise<WebSocket>((resolve, reject) => {
      this.#resolveUpgrade = resolve;
      this.#rejectUpgrade = reject;
    });
    // Swallow unhandled-rejection noise if connect() throws
    // before anyone awaits the promise.
    this.#pendingUpgrade.catch(() => {});
  }

  #clearUpgrade(): void {
    this.#pendingUpgrade = undefined;
    this.#resolveUpgrade = undefined;
    this.#rejectUpgrade = undefined;
  }

  // Drive startup readiness with bounded restart attempts. Each
  // attempt runs the shared probe in a backoff loop until either
  // computerd answers, the per-attempt budget elapses, or the overall
  // connect deadline elapses. On a failed attempt with restarts
  // remaining, run host.restart(env) and try again.
  async #readyWithRestarts(
    host: IWorkspaceContainerAPI,
    env: Record<string, string>,
    deadline: number,
    priorExit: { exitedAt: number; reason: string } | null,
    initialRuntimeId: string,
  ): Promise<string> {
    const maxAttempts = this.#options.restartAttempts + 1;
    // Split the remaining time across attempts so a failing
    // first attempt doesn't starve the restart-retry. Floor at
    // 250ms so a near-deadline last attempt still has room to
    // dispatch a probe rather than collapsing to ~1ms.
    const totalBudget = Math.max(0, deadline - Date.now());
    const perAttemptBudget = Math.max(250, Math.floor(totalBudget / maxAttempts));
    let attempt = 0;
    let restarts = 0;
    let lastError: unknown;
    let runtimeId = initialRuntimeId;

    while (attempt < maxAttempts) {
      attempt++;
      const attemptDeadline = Math.min(deadline, Date.now() + perAttemptBudget);
      const ok = await this.#probeUntilHealthy(host, attemptDeadline).then(
        () => true,
        (error) => {
          lastError = error;
          return false;
        },
      );
      if (ok) return runtimeId;

      if (attempt < maxAttempts) {
        try {
          ({ runtimeId } = await host.restart(env, this.#egress.mode === "direct"));
          restarts++;
        } catch (error) {
          this.#rejectUpgrade?.(error);
          this.#clearUpgrade();
          throw new WorkspaceTransportError(
            this.#formatStageError("restart", {
              attempt,
              maxAttempts,
              restarts,
              lastError: error,
            }),
            { cause: error },
          );
        }
      }
    }

    this.#rejectUpgrade?.(new Error("computerd never became healthy"));
    this.#clearUpgrade();
    throw new WorkspaceTransportError(
      this.#formatStageError("health", {
        attempt,
        maxAttempts,
        restarts,
        lastError,
        priorExit,
      }),
      lastError instanceof Error ? { cause: lastError } : undefined,
    );
  }

  async #probeUntilHealthy(host: IWorkspaceContainerAPI, deadline: number): Promise<void> {
    let delay = this.#options.healthRetryInitialDelayMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await probeComputerdHealth(host, {
          port: this.#options.containerPort,
          path: "/health",
          timeoutMs: Math.min(
            this.#options.healthProbeTimeoutMs,
            Math.max(50, deadline - Date.now()),
          ),
        });
        return;
      } catch (error) {
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, this.#options.healthRetryMaxDelayMs);
      }
    }
    throw lastError ?? new Error("computerd health probe timed out");
  }

  #formatStageError(
    stage: "start" | "egress" | "health" | "restart" | "connect" | "ws",
    info: {
      attempt: number;
      maxAttempts: number;
      restarts: number;
      lastError: unknown;
      priorExit?: { exitedAt: number; reason: string } | null;
    },
  ): string {
    const priorExit = info.priorExit ? ` priorExit=${JSON.stringify(info.priorExit.reason)}` : "";
    return (
      `CloudflareContainerBackend(${this.id}): connect failed at ` +
      `stage=${stage} port=${this.#options.containerPort} ` +
      `attempt=${info.attempt}/${info.maxAttempts} restarts=${info.restarts} ` +
      `timeoutMs=${this.#options.connectTimeoutMs}${priorExit} ` +
      `lastError=${describeError(info.lastError)}`
    );
  }

  async #postConnect(host: IWorkspaceContainerAPI, deadline: number): Promise<void> {
    const remaining = Math.max(0, deadline - Date.now());
    let res: Response;
    try {
      res = await host.fetchPort(this.#options.containerPort, "http://container/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `http://${this.#options.egressHost}`,
          healthTimeoutMs: remaining,
        }),
      });
    } catch (error) {
      this.#rejectUpgrade?.(error);
      this.#clearUpgrade();
      throw new WorkspaceTransportError(
        `CloudflareContainerBackend(${this.id}) [stage=connect]: POST /connect failed: ${describeError(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const cause = new Error(`/connect ${res.status}`);
      this.#rejectUpgrade?.(cause);
      this.#clearUpgrade();
      throw new WorkspaceTransportError(
        `CloudflareContainerBackend(${this.id}) [stage=connect]: POST /connect returned ${res.status}: ${body}`,
        { cause },
      );
    }
  }

  async #waitForUpgrade(deadline: number): Promise<WebSocket> {
    const upgrade = this.#pendingUpgrade;
    if (!upgrade) throw new Error("CloudflareContainerBackend: upgrade promise missing");

    const remaining = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ws = await Promise.race([
        upgrade,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkspaceTransportError(
                  `CloudflareContainerBackend(${this.id}) [stage=ws]: /ws upgrade did not arrive within ${this.#options.connectTimeoutMs}ms`,
                ),
              ),
            remaining,
          );
        }),
      ]);
      return ws;
    } finally {
      if (timer) clearTimeout(timer);
      this.#clearUpgrade();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
