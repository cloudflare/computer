# 08. Capnweb Interface

> [!NOTE]
> This doc now reflects shipped code in `packages/rpc/`. Items marked
> **(planned)** are deferred work.

[capnweb](https://github.com/cloudflare/capnweb) is the RPC framing used
between the Durable Object and the in-container `computerd` computerd.
The wire format is text JSON over a single WebSocket (with an HTTP-batch
alternative). The interface served is `WorkspaceRPC`, defined in
`packages/rpc/src/interface.ts` and consumed by both sides.

## Transport

- **Carrier.** One long-lived WebSocket per Workspace. The DO opens it
  against the computerd's `/ws` endpoint, with `/api` available
  as an HTTP-batch alternative (single POST per call) for callers that
  can't hold a socket. Default port is `45678`; it will become a
  build-time variable so hosts can pin a non-default port.
- **Framing.** capnweb text frames. Binary frames are unsupported.
  **(planned)** the server will fail the session loudly on the first
  binary message; today the behaviour is unspecified.
- **Streams.** `ReadableStream<…>` is a first-class capnweb value, used
  for `ChangeEntry` batches, object transfers, and the `exec` event
  stream.
- **Reconnect.** On close or error the DO-side connection
  self-destructs synchronously from the event handler. The next RPC
  call transparently rebuilds against the still-running
  computerd.

The DO uses a deferred transport so the RPC stub can be created before
the WebSocket upgrade completes — queued sends flush as soon as the
socket is ready.

## `WorkspaceRPC`

The wire surface is split into two halves composed under one root stub:

```ts
export interface WorkspaceRPC {
  sync:  SyncRPC;
  shell: ShellRPC;
}
```

Both halves live in `packages/rpc/src/interface.ts`. The split keeps the
sync surface independently testable from process supervision while the
wire still exposes a single stable stub. Host-side callers reach each
half via `.sync` / `.shell`.

### `SyncRPC`

```ts
interface SyncRPC {
  // DO → container. Stream a coalesced batch of changes. Bytes are
  // not inline: the DO sends ChangeEntry records with chunk hashes,
  // the receiver calls back via hasObjects / pushObjects for the
  // missing subset. Returns the receiver's new rev plus the
  // appliedPushCursor it stamped for this batch.
  push(input: {
    senderRev: number;
    changes:   ReadableStream<ChangeEntry>;
  }): Promise<{
    rev:               number;
    appliedPushCursor: { rev: number; path: string | null };
  }>;

  // Container ← DO. Stream every ChangeEntry after `after`, ordered
  // by rev then path. The cursor is a resume point, not a snapshot
  // handle: path=null means every change committed at or before that
  // rev has been offered; a cursor with path set resumes after that
  // path inside the same rev. A path rewritten after the stream opens
  // is deferred to a later cursor rather than frozen at this rev (see
  // docs/02). `currentCursor` is the receiver's currentRev at stream
  // open with path=null, and `appliedPushCursor` is the receiver's
  // cursor for sender changes it has applied. Per-file entries carry
  // (hash, size) chunk lists; no bytes inline.
  fetchChanges(input: {
    after?:  { rev: number; path: string | null };
    ignore?: string[];
  }): Promise<{
    currentCursor:  { rev: number; path: string | null };
    appliedPushCursor: { rev: number; path: string | null };
    stream:         ReadableStream<ChangeEntry>;
  }>;

  // Diagnostic surface for soak tests, dashboards, and the agent
  // when it wants to wait for the wire to drain. pushRev /
  // fetchCursor only move when the receiver is acting as a sync
  // peer; otherwise they sit at 0 / { rev: 0, path: null }.
  watermarks(): Promise<{
    currentRev: number;
    pushRev:    number;
    fetchCursor: { rev: number; path: string | null };
  }>;

  // Materialise a single path as a ChangeEntry without driving
  // the full fetchChanges stream. Returns null when the path
  // doesn't exist and hasn't been tombstoned. Used by
  // interactive readers.
  readEntry(path: string): Promise<ChangeEntry | null>;

  // Git's `have` line, batched. Returns the subset of the input
  // the receiver already holds.
  hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;

  // Container → DO direction of object transfer. Throws
  // EUNKNOWN_HASH if any hash is unknown — callers must dedupe
  // and probe first.
  fetchObjects(hashes: Uint8Array[]):
    ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>;

  // DO → container direction of object transfer. Accepts a
  // ReadableStream of { hash, bytes } pairs (not an array) so
  // the DO can interleave object reads with the wire send and
  // keep peak memory bounded.
  pushObjects(
    objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>
  ): Promise<void>;
}
```

The durable object and `computerd` are deployed as a matched pair. This
interface has no version negotiation, so request and response shape
changes are hard wire breaks and require lockstep rollout.

`ChangeEntry` is defined in `packages/dofs/src/sync/changes.ts`. Schema
column references match [03. Filesystem Schema](./03_filesystem_schema.md).

#### Rev-0 baseline (no separate snapshot)

There is no dedicated `snapshot()` RPC. A fresh DO with no watermark
calls `fetchChanges({ after: { rev: 0, path: null } })`, which streams
every live entry plus any tombstones the receiver has retained.
Treating the baseline as a degenerate fetch keeps the wire shape
minimal: the same pull path covers both cold-start replication and
incremental catch-up.

#### Push semantics: peer vs external

`push` distinguishes two callers via `senderRev`:

- **`senderRev > 0` — sync peer.** The sender is replicating its own
  log forward. The receiver advances its fetch cursor to
  `{ rev: senderRev, path: null }` once the batch settles, echoes it
  back as `appliedPushCursor`, and uses that value to silence the
  loopback (the next `fetchChanges` from the peer won't replay these
  entries back at it).
- **`senderRev === 0` — external orchestrator.** The sender doesn't
  have a rev space of its own (an agent, a CI script, a one-shot
  writer). The receiver applies the batch as ordinary local writes,
  stamps fresh local revs, and leaves `pushRev` untouched.

See SUMMARY §0 'Investigation notes' (commits dc692c0, c95c74d,
69be34f, aea0f5e, dec176b) for how this shape settled.

### `ShellRPC`

```ts
interface ShellRPC {
  // Spawn an execution. `source` is a shell command line for a
  // command backend, or module source for a callable backend.
  // Returns a handle whose `events` stream yields stdout / stderr /
  // exit frames. The stream is the single source of truth — there
  // is no buffered-return variant. The handle's id can be passed to
  // getExec to reattach after a reconnect. `input` carries a
  // structured value for a callable backend; command backends
  // ignore it.
  exec(input: {
    source: string;
    cwd?:   string;
    id?:    string;
    input?: unknown;
  }): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;

  // Reattach to an in-flight or recently-completed exec by id.
  // Pass `after` to resume from a known seq; "tail" yields only
  // future events; omit to receive every event from the start.
  getExec(input: {
    id:      string;
    after?:  number | "tail";
  }): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;

  // Signal a running exec. No-op once the process has exited.
  killExec(input: {
    id:      string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void>;

  // Release the event log for a completed exec. Future getExec
  // on the same id throws ENOENT.
  disposeExec(input: { id: string }): Promise<void>;
}

type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit";   code: number; result?: unknown };
```

The `exit` frame carries the process exit code on `code` and, for a callable
backend that ran to a zero exit, the structured return value on
`result`. The result and the exit code settle together, so a single
terminal frame carries both rather than splitting them across two
frames. Command backends never set `result`.

All payloads on the wire are binary. The host-side `Workspace.runtime`
converts to `string` when the caller passes `encoding: "utf8"`. Every
event carries a monotonic `seq` (per exec id) so callers can resume
from a known point after a disconnect.

## Push and fetch semantics

Push and fetch are symmetric. The same `ChangeEntry` shape moves in
both directions, and the same `hasObjects` probe runs against both
ends:

- **Push (DO → container).** The DO calls `push({ senderRev, changes })`
  streaming `ChangeEntry` records, the container calls `hasObjects` on
  the chunk hashes referenced, the DO follows up with `pushObjects`
  (itself a stream) for the missing subset, the container applies the
  batch and returns `{ rev, appliedPushCursor }`.
- **Fetch (container → DO).** The DO calls `fetchChanges({ after })`,
  which returns `{ currentCursor, appliedPushCursor, stream }` in one round-
  trip. `currentCursor` is the target cursor; `appliedPushCursor`
  carries the cross-side invariant (the puller asserts it covers
  `{ rev: pushRev, path: null }` before draining). The DO then streams
  `ChangeEntry` records, accumulates chunk hashes, calls `hasObjects`
  on itself (cheap, local) to find what it already has, then calls
  `fetchObjects` for the rest.

| Aspect | Value |
| --- | --- |
| Round-trips per fetch | 1 streaming `fetchChanges` (carries `currentCursor` + `appliedPushCursor` + entry stream) + 1 `hasObjects` per batch + 1 streaming `fetchObjects` per batch (only if any hashes are missing) |
| Round-trips per push | 1 streaming `push` (carries `senderRev`) + 1 `hasObjects` (server-driven) + 1 streaming `pushObjects` (only if any hashes are missing) |
| Bytes inline in `ChangeEntry` | None — entries carry chunk hashes only |
| Object transfer shape | `ReadableStream<{ hash, bytes }>` in both directions |
| Dedup | Global, content-addressed by `sha256(chunk)`. Applies in both directions. |

Identical content at multiple paths costs exactly one entry on the wire
and zero object-fetch round-trips if the receiver already has the blob.
Streaming both the change list and the object transfer keeps peak
memory bounded on both sides regardless of how much was touched. See
[02. Sync Protocol](./02_sync_protocol.md) for how this composes into
the push/fetch cycle.

### Per-Workspace FIFO mutation queue (planned)

**(planned).** Mutating calls (`push`, `pushObjects`,
`exec` start, `killExec`, `disposeExec`) against a single Workspace
will be serialised through a FIFO queue so that concurrent peers can't
interleave half-applied batches. Read-only calls (`fetchChanges`,
`fetchObjects`, `hasObjects`, `currentRev`, `watermarks`, `readEntry`,
`getExec`) bypass the queue.

## Backpressure on the exec stream

`exec` and `getExec` return a `ReadableStream<ExecEvent>` whose
consumer-side backpressure propagates all the way to the spawned
process via the kernel pipe. The runner uses WHATWG pull-based
backpressure end-to-end — there is no in-process ring buffer. When the
consumer stops pulling, the runner stops `read()`ing the child's
stdout/stderr; the kernel pipe fills and the child blocks on `write`.
Chatty commands self-regulate the same way they would under a slow
`tee` or `less` on a normal shell.

See SUMMARY §0 (commit 89b4717) for why we landed on pull-based
backpressure rather than the originally-planned in-memory ring.

**(planned)** the host-side exec handle will grow `pause()` /
`resume()` for callers that want to throttle without
relying on stream-pull semantics. See
[05. Shell Interface](./05_runtime_interface.md).

## Stream replay and durability

Every `ExecEvent` is written straight to the SQLite-backed
`computerd_exec_events` table (`packages/computerd/src/exec/log.ts`). `getExec({
id, after })` resumes by selecting rows with `seq > after`. There is no
separate in-memory log and no file spill — SQLite is the durable
substrate.

Retention is bounded:

- The log is kept until the DO calls `disposeExec(id)`, **or** until a
  TTL after exit (default 5 minutes), **or** until the total log size
  for one exec exceeds the per-exec cap (default 16 MiB). Whichever
  comes first wins. These are retention bounds on the durable log, not
  backpressure thresholds — the kernel pipe handles backpressure.
- If the log has been evicted, `getExec` rejects with `ELOG_TRUNCATED`
  (see error codes below). Callers must be prepared for this and
  restart the exec if they need a clean replay.

## Error model

Errors thrown over the wire carry a structured code so callers can
branch without string-matching:

```ts
type WireErrorCode =
  | "ENOENT"
  | "EUNKNOWN_HASH"
  | "ESHUTDOWN"
  | "EAUTH"
  | "EPROTOCOL"
  | "EEXEC_BUSY"
  | "ELOG_TRUNCATED";

type WireError = {
  code:    WireErrorCode;
  message: string;
};
```

| Code | Meaning |
| --- | --- |
| `ENOENT` | Path does not exist on the receiver (covers ignored paths, which are invisible to `Workspace.fs`), or `getExec` / `disposeExec` referenced an unknown id. |
| `EUNKNOWN_HASH` | `fetchObjects` or `pushObjects` referenced a hash the receiver has no record of; raised via `createWorkspaceError`. |
| `EEXEC_BUSY` | `exec` was called with an `id` that's already in use by a live run. |
| `ELOG_TRUNCATED` | `getExec` resume point is older than the retained log. |
| `ESHUTDOWN` | **(reserved)** Server is shutting down; reconnect after the next boot. Not raised today. |
| `EAUTH` | **(reserved)** Handshake auth failed. Not raised today — the handshake is unauthenticated; see [07. Injected Service](./07_injected_service.md). |
| `EPROTOCOL` | **(reserved)** Wire framing or version mismatch. Not raised today. |

The host-side capnweb adapter rethrows as `WorkspaceError`. Today
capnweb forwards own-enumerable properties verbatim, and
`workspace-fs/errors.ts` only enumerates fs codes (not wire codes), so
the wire `code` survives by accident on fs errors but is **not yet
guaranteed** for sync / shell errors. Making the typed rethrow with
`code` preservation a contract is a deferred follow-up.

## Observability

The host-side `createSyncClient` accepts an optional `onRPCEvent`
callback fired once per RPC with `{ rpc, durationMs, ok, code? }`.

- The composite `createWorkspaceClient` does **not** accept
  `onRPCEvent` today.
- The host `Workspace` class has **no** `onRpcEvent` option today.
- Frame-size metrics (`bytesIn` / `bytesOut`) are **(planned)**
  — capnweb does not currently surface per-call frame sizes
  through its stub API, so the hook can't fill them in.

Server-side, structured records land in `LOG_FILE` (see
[07. Injected Service](./07_injected_service.md)). Neither side bakes
in a tracing dependency — the callback is the integration point for
OpenTelemetry, Workers Analytics Engine, or whatever the host Worker
already uses.

## Open questions

These behaviours aren't fully specified yet. File an issue if your use
case depends on a particular resolution.

- **Compatibility dates.** The DO and the computerd are
  versioned independently — the DO ships with its host Worker, the
  server ships in the sandbox image. They can drift. The intent is to
  follow Workers' compatibility-date model: the DO declares a
  `compatibilityDate` on construction, the server reports its supported
  date range on the handshake, and a mismatch outside the supported
  window fails the connection hard with a clear error rather than
  attempting a graceful fallback. Open: where the date is declared
  (constructor option, env var, both), the wire shape of the
  handshake, and which categories of change require a date bump
  (additive vs. breaking).
- **Connection auth.** The handshake currently trusts anything that
  can reach the port. See the same item in
  [07. Injected Service](./07_injected_service.md#open-questions); the
  capnweb side will likely grow a pre-bootstrap auth phase to match
  whatever scheme the injected service settles on.
- **Frame-size and message limits.** The wire has no documented
  bound on single-frame size, in-flight RPC count, or
  `hasObjects` / `fetchObjects` / `pushObjects` batch size. A
  pathological caller can ask for 100k hashes in one call and pin
  both sides on a single oversized frame. Working defaults are
  likely 16 MiB per frame, 256 concurrent RPCs per session, and
  1024 hashes per object-transfer batch — but they need measurement
  and an enforcement story (reject loudly? split silently?) before
  they go in the contract.

See [02. Sync Protocol](./02_sync_protocol.md) for how these RPCs
compose into a push/pull cycle, and
[07. Injected Service](./07_injected_service.md) for the server that
hosts them.
