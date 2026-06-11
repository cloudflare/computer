// CloudflareContainerBackend — backs Workspace with a wsd instance
// running inside a Cloudflare Container.
//
// The backend drives container lifecycle through an IWorkspaceContainerAPI
// abstraction. Same-DO and cross-DO callers look identical from
// here; whether ctx.container is reached directly or through an
// RPC stub is a concern of the IWorkspaceContainerAPI implementation.
//
// Same-DO shape (one DO owns both the container and the Workspace):
//
//   class WsdContainer extends DurableObject<Env> {
//     #backend = new CloudflareContainerBackend({
//       container: () => this.ws,
//       workspace: { binding: "WsdContainer", id: this.ctx.id.toString() },
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
//         return this.env.WsdHost.get(this.env.WsdHost.idFromString(memberId));
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

import type { WorkspaceRPC } from "@cloudflare/workspace-rpc";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { startHeartbeat } from "../../heartbeat.js";
import type { IWorkspaceContainerAPI, WorkspaceRef } from "./container-host.js";

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

  // Hostname wsd will dial back. Defaults to "workspace.internal".
  // Override for tests or to avoid collisions with other backends
  // sharing the same container host.
  egressHost?: string;

  // TCP port wsd listens on inside the container. Default 8080,
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

  // Selector this backend is registered under in Workspace.
  // Defaults to "cloudflare-container"; override when the
  // workspace hosts more than one instance of the same backend
  // kind (e.g. two containers pinned to different pool members).
  id?: string;
}

const DEFAULT_EGRESS_HOST = "workspace.internal";
const DEFAULT_CONTAINER_PORT = 8080;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

export class CloudflareContainerBackend implements WorkspaceBackend {
  readonly type = "cloudflare-container";
  readonly id: string;

  readonly #options: Required<
    Omit<CloudflareContainerBackendOptions, "container" | "workspace" | "containerEnv" | "id">
  > &
    Pick<CloudflareContainerBackendOptions, "container" | "workspace" | "containerEnv">;

  // State for the in-flight /ws upgrade. handleFetch() resolves
  // #pendingUpgrade; connect() awaits it.
  #pendingUpgrade: Promise<WebSocket> | undefined;
  #resolveUpgrade: ((ws: WebSocket) => void) | undefined;
  #rejectUpgrade: ((err: unknown) => void) | undefined;

  // Cached after the first successful connect(). Cleared on close()
  // or when the underlying WebSocket reports `close` / `error`.
  #handle: BackendHandle | undefined;

  constructor(options: CloudflareContainerBackendOptions) {
    this.id = options.id ?? "cloudflare-container";
    this.#options = {
      container: options.container,
      workspace: options.workspace,
      containerEnv: options.containerEnv,
      egressHost: options.egressHost ?? DEFAULT_EGRESS_HOST,
      containerPort: options.containerPort ?? DEFAULT_CONTAINER_PORT,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    };
  }

  async connect(): Promise<BackendHandle> {
    if (this.#handle) return this.#handle;

    const deadline = Date.now() + this.#options.connectTimeoutMs;
    const holder = await this.#options.container();
    const host = await holder.getWorkspaceContainer();

    await host.start({
      PORT: String(this.#options.containerPort),
      MOUNT_POINT: "/workspace",
      ...this.#options.containerEnv,
    });
    await host.interceptOutboundHttp(this.#options.egressHost, this.#options.workspace);

    // Arm the upgrade promise before posting /connect — wsd
    // dials back as soon as /health on the egress answers, so
    // the upgrade can arrive before the POST resolves.
    this.#armUpgrade();

    await this.#waitForPort(host, deadline);
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

  async #waitForPort(host: IWorkspaceContainerAPI, deadline: number): Promise<void> {
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await host.fetchPort(this.#options.containerPort, "http://container/health", {
          method: "HEAD",
        });
        void res.body?.cancel();
        return;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    this.#rejectUpgrade?.(new Error("port did not open"));
    this.#clearUpgrade();
    throw new Error(
      `CloudflareContainerBackend: container port ${this.#options.containerPort} did not open: ${describeError(lastError)}`,
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
      throw new Error(`CloudflareContainerBackend: POST /connect failed: ${describeError(error)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.#rejectUpgrade?.(new Error(`/connect ${res.status}`));
      this.#clearUpgrade();
      throw new Error(`CloudflareContainerBackend: POST /connect returned ${res.status}: ${body}`);
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
                new Error(
                  `CloudflareContainerBackend: /ws upgrade did not arrive within ${this.#options.connectTimeoutMs}ms`,
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
