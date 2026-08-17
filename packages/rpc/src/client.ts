// Client-side adapter: turn a WebSocket URL into a typed SyncRPC
// stub. Capnweb's newWebSocketRpcSession does the actual dial; we
// own the connection lifecycle and expose a close() for clean
// teardown.

import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { SyncRPC, WorkspaceRPC } from "./interface.js";

export interface RPCEvent {
  rpc: keyof SyncRPC;
  durationMs: number;
  ok: boolean;
  code?: string;
}

export interface ClientOptions {
  // WebSocket URL. Typically ws://container-host:45678/api.
  url: string;
  // Optional WebSocket constructor. Defaults to the global
  // WebSocket (node 22+ ships one; older runtimes can pass the
  // `ws` package's WebSocket here).
  WebSocketImpl?: typeof WebSocket;
  // Fired once per RPC with timing + outcome. Hook into whatever
  // observability surface the host already uses. bytesIn /
  // bytesOut aren't exposed yet — capnweb doesn't surface
  // per-call frame sizes through the stub API.
  onRPCEvent?: (event: RPCEvent) => void;
}

export interface SyncClient extends SyncRPC {
  // Close the WebSocket and tear down the stub. Idempotent.
  close(): Promise<void>;
}

// Open a SyncRPC session against `url`. The first call to any
// method on the returned stub queues until the WebSocket reaches
// readyState OPEN; capnweb's transport handles that.
export function createSyncClient(options: ClientOptions): SyncClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  // The WebSocket cast crosses two type boundaries: the runtime
  // ws (node `ws` package or global) is structurally compatible
  // with capnweb's expected globalThis.WebSocket but TS can't
  // bridge the nominal types. The RpcStub cast names the remote
  // interface so the Proxy returned downstream is strongly typed.
  const stub = newWebSocketRpcSession(ws as unknown as globalThis.WebSocket) as RpcStub<SyncRPC>;
  // capnweb's RpcStub is a Proxy that exposes the remote interface
  // as if it were local. We wrap it so callers see SyncClient
  // (= SyncRPC + close).
  const onEvent = options.onRPCEvent;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async () => {
          // Dispose the root stub first — per capnweb's docs this
          // is the documented way to close a session and lets the
          // RPC layer send a clean abort frame before the transport
          // dies. ws.close() below is belt-and-braces.
          try {
            (target as unknown as Disposable)[Symbol.dispose]?.();
          } catch {
            // already disposed; idempotent
          }
          await new Promise<void>((resolve) => {
            const w = ws as unknown as { readyState: number; close: () => void };
            if (w.readyState >= 2) {
              resolve();
              return;
            }
            (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
              once: true,
            });
            w.close();
            // Belt-and-braces: if `close` never fires (the socket
            // was already torn down) the timeout breaks the await.
            setTimeout(resolve, 200);
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (onEvent === undefined || typeof prop !== "string") return value;
      // Capnweb's Proxy returns a callable RpcPromise/RpcStub for
      // every string property. Wrap the call to time it and fire
      // onRPCEvent. The wrapped value still behaves like an
      // RpcPromise (thenable + property-access for pipelining) for
      // calls that return synchronously-pipelined values; we only
      // measure the awaited terminal call.
      return (...args: unknown[]) => {
        const start = Date.now();
        const result = (value as (...a: unknown[]) => unknown)(...args);
        // For non-thenable returns (streams), fire the event
        // immediately with ok=true. The caller may still throw
        // while reading the stream; observability for that path
        // belongs to the caller.
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
              return v;
            },
            (err) => {
              onEvent({
                rpc: prop as keyof SyncRPC,
                durationMs: Date.now() - start,
                ok: false,
                code: (err as { code?: string })?.code,
              });
              throw err;
            },
          );
        }
        onEvent({ rpc: prop as keyof SyncRPC, durationMs: Date.now() - start, ok: true });
        return result;
      };
    },
    // The Proxy is structurally a SyncRPC stub + the close()
    // override; TS can't infer that from the get-handler shape,
    // so route through unknown to land on SyncClient.
  }) as unknown as SyncClient;
}

export interface WorkspaceClient extends WorkspaceRPC {
  close(): Promise<void>;
}

// Open a WorkspaceRPC session. Same transport as createSyncClient,
// different stub shape: callers reach the sync half via `.sync`
// and the shell half via `.shell`.
//
// onRPCEvent isn't wired here yet — the composite stub's
// property-access path is `stub.sync.push(...)` which capnweb
// surfaces as a two-step proxy traversal; the per-call timing
// shim from createSyncClient doesn't compose cleanly. Add when a
// caller actually needs it.
export function createWorkspaceClient(options: {
  url: string;
  WebSocketImpl?: typeof WebSocket;
}): WorkspaceClient {
  const WS = options.WebSocketImpl ?? WebSocket;
  const ws = new WS(options.url);
  // Same WebSocket / RpcStub cast pattern as createSyncClient —
  // see comment there. WorkspaceRPC adds the composite shape so
  // callers can pipeline `.sync.push(...)` and `.shell.exec(...)`.
  const stub = newWebSocketRpcSession(
    ws as unknown as globalThis.WebSocket,
  ) as RpcStub<WorkspaceRPC>;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async () => {
          // Same dispose-before-close pattern as createSyncClient.
          try {
            (target as unknown as Disposable)[Symbol.dispose]?.();
          } catch {
            // already disposed; idempotent
          }
          await new Promise<void>((resolve) => {
            const w = ws as unknown as { readyState: number; close: () => void };
            if (w.readyState >= 2) {
              resolve();
              return;
            }
            (ws as unknown as EventTarget).addEventListener("close", () => resolve(), {
              once: true,
            });
            w.close();
            setTimeout(resolve, 200);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
    // As in createSyncClient, the Proxy is structurally a
    // WorkspaceRPC stub + close(); route through unknown so TS
    // accepts the WorkspaceClient landing type.
  }) as unknown as WorkspaceClient;
}
