// Public surface of @cloudflare/computer-rpc.
//
// The package is split into four entry points:
//
//   - .          — the typed wire interface and error shape.
//   - ./server   — a Database-backed implementation of the interface.
//                  Imported by DO code and by the in-container
//                  computerd.
//   - ./client   — a typed stub over a WebSocket carrier.
//   - ./driver   — the pull/push sync loop helpers that drive a
//                  SyncRPC client through one tick of work.
//
// The interface is the load-bearing surface. server.ts and
// client.ts both target it; either can be swapped for an
// alternative implementation (a queue-backed server for replay
// tests, a mock client for unit tests) without changing call sites.

export type {
  ExecEvent,
  ShellRPC,
  SyncRPC,
  WireError,
  WireErrorCode,
  WorkspaceRPC,
} from "./interface.js";
