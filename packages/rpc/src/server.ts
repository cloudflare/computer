// Server-side adapter: a SQLite-backed Database becomes a SyncRPC.
//
// The DO uses this to expose its sync surface to the container, and
// the in-container computerd uses it to expose its mirror to
// the DO. Same code on both ends; what differs is who calls whom.

import {
  applyChangesSync,
  type ChangeCursor,
  type ChangeEntry,
  coalesceChanges,
  compareChangeCursors,
  currentRev,
  type Database,
  DEFAULT_IGNORE,
  fetchObjects,
  hasObjects,
  materialiseChange,
  readFetchCursor,
  readWatermark,
  stageBlob,
  writeFetchCursor,
} from "@cloudflare/dofs";
import { newWebSocketRpcSession, nodeHttpBatchRpcResponse, RpcTarget } from "capnweb";

import { trackStub, untrackStub } from "./debug.js";
import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "./interface.js";

// Subset of computerd's Runner that the shell server needs. Defining
// the shape here (instead of importing the concrete class) keeps
// computer-rpc free of a computerd dependency — the package builds and
// runs without computerd's process-supervision code on the path.
export interface RunnerLike {
  exec(
    command: string,
    options?: {
      id?: string;
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      stdin?: Uint8Array;
    },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  get(
    id: string,
    options?: { after?: number | "tail" },
  ): {
    id: string;
    events: ReadableStream<ExecEvent>;
  };
  kill(id: string, signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): void;
  dispose(id: string): void;
}

export interface ServerOptions {
  ignore?: string[];
  /**
   * Optional hook fired inside the SyncRPC `push` handler, right
   * after a successful peer batch has been committed. Resolved
   * before `push()` returns to the caller. Used by computerd to settle
   * the userspace shim layer so a subsequent `shell.exec` sees the
   * just-pushed files on disk.
   *
   * Errors are caught and logged — the push itself already
   * succeeded; the caller should not see a flush failure as a
   * push failure.
   */
  afterApply?: () => void | Promise<void>;
  /**
   * Optional hook fired inside the SyncRPC `fetchChanges` handler,
   * right before the receiver computes the change set the puller
   * will see. Resolved before any entries stream. Used by computerd to
   * settle the userspace shim's disk→VFS reconcile so a
   * `Workspace.pull()` issued right after `shell.exec` returns the
   * files the exec'd process wrote, without waiting on the shim's
   * periodic poll.
   *
   * Fires on every fetch, including ones that would otherwise
   * stream zero entries — the hook is what produces the entries in
   * the first place. Errors are caught and logged; a hook failure
   * must not fail the fetch.
   */
  beforeFetch?: () => void | Promise<void>;
}

class SyncRPCServer extends RpcTarget implements SyncRPC {
  constructor(
    private readonly db: Database,
    private readonly options: Required<Pick<ServerOptions, "ignore">> &
      Pick<ServerOptions, "afterApply" | "beforeFetch">,
  ) {
    super();
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  async push(input: {
    senderRev: number;
    changes: ReadableStream<ChangeEntry>;
  }): Promise<{ rev: number; appliedPushCursor: ChangeCursor }> {
    const entries: ChangeEntry[] = [];
    const reader = input.changes.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        entries.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    // senderRev > 0 — the caller is a sync peer with its
    // own rev space; advance the fetch cursor to that point so
    // subsequent pulls and the cross-side invariant check see the
    // right appliedPushCursor. The apply path's alreadyApplied()
    // check is what stops the entries from ping-ponging back
    // through the sender's own coalesce + apply loop on the next
    // round trip.
    //
    // senderRev === 0 — the caller is an external writer
    // (an orchestrator using the wire as a transport, the
    // soak script, a manual curl). Treat the entries as
    // local writes: bump rev through the normal apply path,
    // leave pushRev untouched so the outbound sync loop
    // ships them upstream on the next tick.
    const isPeer = input.senderRev > 0;
    // Wrap the whole batch in a single transactionSync so a
    // mid-stream failure (e.g. a missing chunk in applyChangesSync's
    // assembly step) rolls back every prior entry. Without this
    // wrapper the receiver could be left with a subset of the
    // pushed entries committed.
    this.db.transactionSync(() => {
      applyChangesSync(this.db, entries, new Map(), {
        source: isPeer ? "upstream" : "local",
      });
      if (isPeer) {
        const nextCursor = { rev: input.senderRev, path: null };
        if (compareChangeCursors(nextCursor, readFetchCursor(this.db)) > 0) {
          writeFetchCursor(this.db, nextCursor);
        }
      }
    });
    if (this.options.afterApply !== undefined && entries.length > 0) {
      try {
        await this.options.afterApply();
      } catch (err) {
        // Settle hook failures must not surface as push failures —
        // the entries are already committed. Log so the operator
        // notices a wedged shim, then return success.
        console.warn("[SyncRPCServer] afterApply hook failed:", err);
      }
    }
    return {
      rev: currentRev(this.db),
      appliedPushCursor: { rev: input.senderRev, path: null },
    };
  }

  async fetchChanges(input: { after?: ChangeCursor; ignore?: string[] }): Promise<{
    currentCursor: ChangeCursor;
    appliedPushCursor: ChangeCursor;
    stream: ReadableStream<ChangeEntry>;
  }> {
    if (this.options.beforeFetch !== undefined) {
      try {
        await this.options.beforeFetch();
      } catch (err) {
        // Settle hook failures must not surface as fetch failures —
        // we still want to stream whatever's already in the store.
        // Log so the operator notices a wedged shim, then carry on.
        console.warn("[SyncRPCServer] beforeFetch hook failed:", err);
      }
    }
    const after = input.after ?? { rev: 0, path: null };
    const ignore =
      input.ignore ?? (this.options.ignore.length > 0 ? this.options.ignore : DEFAULT_IGNORE);
    const snapshotRev = currentRev(this.db);
    const currentCursor = { rev: snapshotRev, path: null };
    return {
      currentCursor,
      appliedPushCursor: readFetchCursor(this.db),
      stream: iterableToReadableStream(
        coalesceChanges(this.db, after, { ignore, through: currentCursor }),
      ),
    };
  }

  async readEntry(path: string): Promise<ChangeEntry | null> {
    return materialiseChange(this.db, path);
  }

  async watermarks(): Promise<{ currentRev: number; pushRev: number; fetchCursor: ChangeCursor }> {
    return {
      currentRev: currentRev(this.db),
      pushRev: readWatermark(this.db, "pushRev"),
      fetchCursor: readFetchCursor(this.db),
    };
  }

  async hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    return hasObjects(this.db, hashes);
  }

  fetchObjects(hashes: Uint8Array[]): ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }> {
    return iterableToReadableStream(fetchObjects(this.db, hashes));
  }

  async pushObjects(
    objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>,
  ): Promise<void> {
    const reader = objects.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stageBlob(this.db, value.hash, value.bytes, Date.now());
      }
    } finally {
      reader.releaseLock();
    }
  }
}
class ShellRPCServer extends RpcTarget implements ShellRPC {
  constructor(private readonly runner: RunnerLike) {
    super();
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  async exec(input: {
    command: string;
    cwd?: string;
    id?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    stdin?: Uint8Array;
  }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.exec(input.command, {
      id: input.id,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      stdin: input.stdin,
    });
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<{
    id: string;
    events: ReadableStream<ExecEvent>;
  }> {
    return this.runner.get(input.id, { after: input.after });
  }

  async killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void> {
    this.runner.kill(input.id, input.signal);
  }

  async disposeExec(input: { id: string }): Promise<void> {
    this.runner.dispose(input.id);
  }
}

// Composite server: exposes both halves as named fields on one
// stub. Capnweb walks the property tree on demand, so callers
// only pay for the half they reach.
class WorkspaceRPCServer extends RpcTarget implements WorkspaceRPC {
  // sync / shell are exposed as getters — capnweb's RpcTarget
  // refuses to traverse plain instance properties (the readLoop
  // raises 'instance properties cannot be accessed over RPC').
  // Getters look like methods to the dispatch path.
  #sync: SyncRPC;
  #shell: ShellRPC;
  constructor(sync: SyncRPC, shell: ShellRPC) {
    super();
    this.#sync = sync;
    this.#shell = shell;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }
  get sync(): SyncRPC {
    return this.#sync;
  }
  get shell(): ShellRPC {
    return this.#shell;
  }
}

// Construct a SyncRPC bound to `db`. The carrier (HTTP server +
// WebSocketServer) is the caller's responsibility; this just hands
// back the object to mount on each connection via
// acceptWebSocketSession().
export function createSyncServer(db: Database, options: ServerOptions = {}): SyncRPC {
  return new SyncRPCServer(db, {
    ignore: options.ignore ?? [],
    afterApply: options.afterApply,
    beforeFetch: options.beforeFetch,
  });
}

// Construct a ShellRPC bound to a Runner. computerd holds the only
// Runner today; tests can pass a fake that implements RunnerLike.
export function createShellServer(runner: RunnerLike): ShellRPC {
  return new ShellRPCServer(runner);
}

// Construct the composite WorkspaceRPC. The wire serves this on
// /ws so clients reach `.sync` and `.shell` through one session.
export function createWorkspaceServer(
  db: Database,
  runner: RunnerLike,
  options: ServerOptions = {},
): WorkspaceRPC {
  return new WorkspaceRPCServer(createSyncServer(db, options), createShellServer(runner));
}

// Attach a capnweb RPC session to a WHATWG-shaped WebSocket. The
// node `ws` package's server-side sockets implement the WHATWG
// surface (addEventListener / send / close), so this works for
// both browser-style sockets and ws-package sockets.
//
// The session is held alive by capnweb's internal event listeners
// until the socket closes; the caller can drop the return value.
// `ws` is typed loosely because we accept both browser-style WebSockets
// (WHATWG EventTarget) and node `ws` package server sockets, which
// share the addEventListener / send / close subset capnweb needs.
export function acceptWebSocketSession(
  ws: WebSocket | { addEventListener: WebSocket["addEventListener"] },
  rpc: SyncRPC | ShellRPC | WorkspaceRPC,
): void {
  newWebSocketRpcSession(ws as unknown as WebSocket, rpc as unknown as RpcTarget);
}

// Serve a single capnweb HTTP-batch session against a SyncRPC. Wraps
// capnweb's nodeHttpBatchRpcResponse so computerd never directly imports
// capnweb (which would split capnweb's module identity in mixed
// ESM/CJS contexts — the RpcTarget instanceof check then fails).
export function serveHTTPBatch(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  rpc: SyncRPC | ShellRPC | WorkspaceRPC,
): Promise<void> {
  return nodeHttpBatchRpcResponse(request, response, rpc as unknown as RpcTarget);
}

function iterableToReadableStream<T>(it: AsyncIterable<T>): ReadableStream<T> {
  const iterator = it[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (iterator.return) await iterator.return(reason as undefined);
    },
  });
}
