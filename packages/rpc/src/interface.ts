// The wire contract for the workspace sync RPC. The DO side and the
// container-side computerd both implement this interface
// against a SQLite-backed VFS; the only thing that differs is which
// direction each method is called from.
//
// Naming summary:
//
//   push           — DO  → container.   Streams ChangeEntry.
//   pushObjects    — DO  → container.   Streams chunk bytes by hash.
//   fetchChanges   — DO  → container.   Streams ChangeEntry (request).
//   fetchObjects   — DO  → container.   Streams chunk bytes by hash (request).
//   hasObjects     — either probes the other. Returns the subset
//                    the receiver already holds.
//
// The exec / getExec / killExec / disposeExec surface hangs off a
// sibling ShellRPC interface. Both compose under the top-level
// WorkspaceRPC, so the wire stub exposes one stable surface while
// the two halves stay internally separable.

import type { ChangeCursor, ChangeEntry } from "@cloudflare/dofs";

export interface SyncRPC {
  // DO → container. Stream a coalesced batch of changes. Bytes are
  // not inline: the DO sends ChangeEntry records with chunk hashes,
  // the container calls back via hasObjects / asks for the missing
  // bytes through pushObjects. `senderRev` is the sender's
  // currentRev at the moment it captured the batch. The receiver
  // advances its fetch cursor to this completed rev after the apply
  // settles, and echoes that cursor back as `appliedPushCursor` so
  // the sender can assert applied covers pushed on every response.
  push(input: {
    senderRev: number;
    senderCursor?: ChangeCursor;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{
    rev: number;
    applied?: number;
    appliedPushCursor: ChangeCursor;
  }>;

  // Container ← DO. Stream every ChangeEntry after the supplied cursor,
  // alongside cursors used to drive the pull:
  //
  //   currentCursor  — the receiver's currentRev captured at the
  //                     start of the stream, with path=null to mark
  //                     the whole rev complete after a clean drain.
  //   appliedPushCursor — the receiver's cursor for sender changes
  //                       it has applied. The puller asserts this
  //                       covers local pushRev before draining,
  //                       mirroring the same check on push.
  //
  // Per-file entries carry (hash, size) chunk lists; no bytes inline.
  fetchChanges(input: {
    after?: ChangeCursor;
    through?: ChangeCursor;
    ignore?: string[];
  }): Promise<{
    currentCursor: ChangeCursor;
    appliedPushCursor: ChangeCursor;
    stream: ReadableStream<ChangeEntry>;
  }>;

  // Read the receiver's full sync watermark state. Cheap (three
  // SQL scalars) and read-only. Diagnostic surface for load
  // tests, dashboards, and the agent's exec stream when it
  // wants to wait for the wire to drain. The three values are:
  //
  //   currentRev  — latest rev stamped on any local mutation.
  //   pushRev     — highest rev already shipped to the upstream.
  //   fetchCursor — upstream fetch cursor, including same-rev path
  //                 progress.
  //
  // pushRev / fetchCursor only move when the receiver is acting as
  // a sync peer. Otherwise they sit at 0. Pass `settle: true` to run
  // the receiver's pre-fetch reconciliation before currentRev is read;
  // deferred command sync uses that as its durable target fence.
  watermarks(input?: { settle?: boolean }): Promise<{
    currentRev: number;
    pushRev: number;
    fetchCursor: ChangeCursor;
  }>;

  // Materialise the receiver's view of a single path as a
  // ChangeEntry. Returns null when the path doesn't exist and
  // hasn't been tombstoned. File entries carry chunk (hash,
  // size) pairs only; the caller follows up with hasObjects +
  // fetchObjects for the bytes. Used by interactive readers
  // that don't want to drive the full fetchChanges stream just
  // to look up one path.
  readEntry(path: string): Promise<ChangeEntry | null>;

  hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Container → DO direction of object transfer. Stream bytes for a
  // set of chunk hashes in request order. Throws EUNKNOWN_HASH if
  // any hash is unknown — callers must dedupe and probe first.
  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

  // DO → container direction of object transfer. The DO streams the
  // bytes the container reported missing (via hasObjects) during a
  // push. Pushed objects are addressable immediately by hash.
  pushObjects(objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>): Promise<void>;
}

// Process supervision surface. Lives alongside SyncRPC. computerd's
// Runner is the concrete implementation today; the interface keeps
// that dependency out of the wire contract.
export interface ShellRPC {
  // Spawn a command in the container. Returns an id (caller-
  // supplied or runner-minted) and a ReadableStream of ExecEvents.
  // Capnweb streams handle backpressure end-to-end; consumer-side
  // slowness propagates to the spawned process via the kernel pipe.
  exec(input: {
    source: string;
    cwd?: string;
    id?: string;
    // Structured value handed to a callable backend. Command
    // backends ignore it; the caller only sends it to backends that
    // declare themselves callable.
    input?: unknown;
    // Per-call timeout in milliseconds. Past this duration the
    // container sends SIGTERM (then SIGKILL after a short grace).
    // 0 disables the timeout. Omit to use the runner's default
    // (typically 320_000).
    timeoutMs?: number;
    // Environment variables inherited by this command only.
    env?: Record<string, string>;
    // Standard input bytes fed to the command.
    stdin?: Uint8Array;
  }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Reattach to an in-flight or recently-completed exec by id.
  // Pass `after` to resume from a known seq; "tail" yields only
  // future events; omit to receive every event from the start.
  getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }>;

  // Signal a running exec. No-op once the process has exited.
  killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;

  // Release the event log for a completed exec. Future getExec on
  // the same id throws ENOENT.
  disposeExec(input: { id: string }): Promise<void>;
}

// Composite stub. The wire serves one of these per session; the
// two halves are independently testable. Host-side callers reach
// each via `.sync` / `.shell`.
export interface WorkspaceRPC {
  sync: SyncRPC;
  shell: ShellRPC;
}

// Code surface a container process reaches by dialing the host's
// egress endpoint. Distinct from WorkspaceRPC: there the daemon is
// the server and the host the client, here the host serves and a
// short-lived command inside the container is the client. The host
// runs the script through a codemode runtime with the connectors it
// was configured with; the container never sees them directly.
export interface CodemodeRPC {
  // TypeScript declarations for every connector a script may call,
  // plus the connector names, which are the globals in scope.
  types(): Promise<CodemodeTypes>;
  // Ranked search over connector methods and saved snippets, for a
  // script author who does not want every declaration at once.
  search(query: string): Promise<CodemodeSearch>;
  // Declarations for one connector, method ("connector.method"), or
  // snippet.
  describe(target: string): Promise<CodemodeDescription>;
  // Run a script body. `code` is the body of an async function; a
  // `return` sends a value back. Never rejects: a script failure is
  // an "error" result, a run waiting on approval is "paused".
  execute(input: { code: string }): Promise<CodemodeResult>;
  // Actions waiting for approval, across every paused run or for one.
  // Read-only: a run pauses because a connector method asked for a
  // human's decision, and the container is never given a way to make
  // it. Approval stays on the host.
  pending(executionId?: string): Promise<CodemodePendingAction[]>;
}

export interface CodemodeTypes {
  types: string;
  connectors: string[];
}

export interface CodemodeSearchResult {
  path: string;
  connector: string;
  method: string;
  description?: string;
  requiresApproval?: boolean;
  kind: "method" | "snippet";
  score: number;
}

export interface CodemodeSearch {
  results: CodemodeSearchResult[];
  total: number;
  truncated: boolean;
}

export interface CodemodeDescription {
  path: string;
  description?: string;
  requiresApproval?: boolean;
  types: string;
  kind: "connector" | "method" | "snippet";
}

export interface CodemodePendingAction {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
}

export type CodemodeResult =
  | { status: "completed"; executionId: string; result?: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: CodemodePendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };

// Every event carries a per-id monotonic `seq`. The host-side
// Workspace.shell decodes value to string when the caller passes
// `encoding: "utf8"`.
export type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; code: number; result?: unknown };

// Error codes carried over the wire. The client adapter rethrows as
// WorkspaceError preserving `code`, so application code can branch
// on err.code rather than parse messages.
export type WireErrorCode =
  | "ENOENT"
  | "EUNKNOWN_HASH"
  | "ESHUTDOWN"
  | "EAUTH"
  | "EPROTOCOL"
  | "EEXEC_BUSY"
  | "ELOG_TRUNCATED";

export interface WireError {
  code: WireErrorCode;
  message: string;
}
