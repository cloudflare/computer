# 11. Lifecycle

> [!NOTE]
> This document describes how the pieces fit together over time: when
> the DO is alive, when the container is alive, when the capnweb
> session is alive, and how hibernation fits in. The hibernation
> section is **forward-looking** — today's code uses `server.accept()`
> on the DO side, not `ctx.acceptWebSocket()`, so the DO is not
> hibernating yet. The rest of this document describes shipped
> behaviour; the durability gaps it surfaces are deferred work.

## Architecture

A workspace pairs **one Durable Object** with **one container instance**
running `wsd`. The DO owns the source-of-truth VFS in its SQLite
storage; the container owns a transient in-memory mirror exposed at the
FUSE mount inside `MOUNT_POINT`. They talk over a single long-lived
capnweb WebSocket session.

```
┌───────────────────────────┐                  ┌────────────────────────┐
│ Durable Object            │                  │ Container              │
│  ┌─────────────────────┐  │                  │  ┌──────────────────┐  │
│  │ Workspace           │  │                  │  │ wsd              │  │
│  │  fs:  WorkspaceFS   │  │                  │  │  HTTP server     │  │
│  │  shell: ShellRPC    │  │                  │  │   /health        │  │
│  │  sync: SyncRPC      │◀─┼── capnweb WS ───▶│  │   /connect /ws   │  │
│  │  push() / pull()    │  │                  │  │  FUSE mount      │  │
│  │  ready()            │  │                  │  │  exec runner     │  │
│  └──────────┬──────────┘  │                  │  └────────┬─────────┘  │
│             │             │                  │           │            │
│  ┌──────────▼──────────┐  │                  │  ┌────────▼─────────┐  │
│  │ SQLite (ctx.storage)│  │                  │  │ In-memory VFS    │  │
│  │  _vfs_watermark     │  │                  │  │  (process-       │  │
│  │  vfs_blobs / nodes  │  │                  │  │   lifetime DB)   │  │
│  └─────────────────────┘  │                  │  └──────────────────┘  │
└───────────────────────────┘                  └────────────────────────┘
        |                                                  |
        | source of truth                  process-lifetime |
        | (durable across restarts)        (lost on restart)|
```

The 1:1 mapping is load-bearing for several reasons:

- The container's WebSocket peer is unambiguous — there is at most one
  capnweb session per DO at any time.
- The DO's persisted watermarks (`pushRev`, fetch cursor) speak to a
  single counterparty.
- Hibernation enablement (see below) becomes tractable because the DO
  doesn't have to multiplex multiple WS peers.

The DO is the WebSocket *server* in this pairing, even though `wsd`
exposes its own `/ws` server-side and could be dialed directly. The
reason for the inversion is documented in
[07. Injected Service §Bootstrap sequence](./07_injected_service.md):
the egress interceptor needs to be wired before any traffic flows, and
having the container dial back through the egress is the simplest way
to make the WS carrier go through DO-controlled routing. The
implication for hibernation is important — `ctx.acceptWebSocket()`
only works for server-accepted WebSockets, so this inversion is what
keeps the hibernation door open.

## DO lifecycle

A Durable Object's life is a sequence of **incarnations** separated by
eviction events. Each incarnation runs in a fresh isolate; in-memory
state is gone between incarnations, but `ctx.storage` survives.

| Event | What survives | What's lost |
| --- | --- | --- |
| **Cold start** (first call after deploy or after eviction) | `ctx.storage` (SQLite, including `_vfs_watermark`) | All in-memory state |
| **Eviction / hibernation** (idle isolate reaped) | `ctx.storage`, hibernatable WebSockets and their `serializeAttachment` payload | In-memory state, non-hibernatable WebSockets |
| **Restart / redeploy** | `ctx.storage` | In-memory state, all WebSockets |
| **OOM / runtime kill** | `ctx.storage` (committed transactions only) | In-memory state, all WebSockets, any uncommitted writes |

The `Workspace` class is constructed in the DO's constructor and holds
`#handle`, `#shell`, `#readyPromise` in memory. None of those survive
an incarnation boundary. What survives is:

- The SQLite store backing `Workspace.fs` — every committed `writeFile`,
  `mkdir`, `rm`, `symlink` is durable.
- The sync watermark rows, which hold `pushRev` (last DO-side rev
  successfully pushed to the container) and the fetch cursor (last
  container-side cursor the DO has fetched). These are written via the
  same SQLite transaction as the data they describe, so they cannot
  drift out of sync with the store.

On every new incarnation `Workspace.ready()` re-runs `#connect()`,
which re-enters the backend's bootstrap sequence. If the container is
still alive, the backend's `POST /connect` + `/ws` handshake produces
a fresh capnweb session against the same in-memory VFS on the
container side. If the container died too (e.g. host OOM took both),
the next sync round is a rev-0 baseline rebuild from the DO's store.

### Wake triggers

A hibernated or evicted DO is re-instantiated by **any inbound event**:

- `fetch()` from outside (e.g. agent code calling `stub.workspace.exec`)
- `fetch()` from another DO via service binding
- `fetch()` from the sandbox container (e.g. the egress callback during
  bootstrap)
- An alarm firing
- An inbound message on a *hibernatable* WebSocket (delivered via
  `webSocketMessage(ws, data)`)

The runtime does not distinguish wake sources. Container-initiated
traffic wakes the DO just like external traffic does.

## Container lifecycle

The container is independent. It is started by the DO via
`container.start(...)` and reaped by Cloudflare Containers' own
lifetime policy. From the DO's perspective:

| Event | What survives | What's lost |
| --- | --- | --- |
| **DO restart, container alive** | The container's in-memory VFS, FUSE mount, `wsd` process | The DO's `#handle` |
| **Container SIGTERM / restart** | The DO's `ctx.storage`, the DO instance itself | The container's in-memory VFS, FUSE mount state, `wsd` process state |
| **Both die** (host OOM, region failure) | `ctx.storage` | Everything else |

`wsd` is a long-lived process. It outlives DO restarts — the
`Container.monitor()` promise resolves only when the container itself
exits, and the backend's `#monitoring` flag drops the cached handle at
that point so the next call rebuilds from scratch
(`cloudflare-container.ts:215-226`).

The critical asymmetry: the **container's VFS is process-lifetime
in-memory**, while the **DO's VFS is durable SQLite**. A container
restart loses container-side state. Sync via `UPSTREAM_URL` (which
the Cloudflare backend wires automatically) is what brings state back
on the next push/pull round.

## Capnweb lifecycle

A capnweb session is a much smaller thing than a DO incarnation or a
container lifetime — it lives only as long as the underlying WebSocket
does, and it carries no durability of its own.

### What capnweb owns

- **Export table.** Map of export ID → stub or `RpcTarget` reachable
  from the peer.
- **Answer table.** Pending RPC promises waiting for replies from
  the peer.
- **Active streams.** `ReadableStream` readers and writers currently
  draining (e.g. `fetchChanges`, `fetchObjects`, `pushObjects`,
  exec events).
- **Socket reference.** The underlying `WebSocket` instance.

All four are **in-memory only**. None survive isolate eviction, OOM,
container restart, or any other form of process death. capnweb's
contract on transport failure is: error every pending answer, fire
the `close` callback, the session is gone.

### Where capnweb attaches in our code

On the DO side: `newWebSocketRpcSession(ws)` in
`CloudflareContainerBackend.connect()` (`cloudflare-container.ts:138-140`).
This installs `addEventListener("message", ...)` on the accepted
WebSocket, which means **the DO must be alive in memory to receive
frames**. There is no hibernation-aware variant today.

On the container side: `acceptWebSocketSession(ws, rpc)` in
`wsd.ts:181` for inbound `/ws` upgrades, or the same call in the
`/connect` outbound dial path at `wsd.ts:266`. Both attach to a `ws`
package WebSocket and require the `wsd` process to be live.

### Session lifecycle, today

1. **Birth.** DO's `Workspace.ready()` → `backend.connect()` →
   `newWebSocketRpcSession()` after the bootstrap dance completes.
2. **Use.** RPC calls flow in both directions; streams are opened,
   drained, and closed within the lifetime of a single push or pull
   round. Between rounds the session is idle but the socket is open.
3. **Death.** The WebSocket closes (clean or RST). capnweb errors
   every pending answer. The session is unrecoverable.

The death case today is **not handled** — the `Workspace` keeps its
`#handle` reference pointing at the dead session, and the next RPC
call throws. The caller is expected to reconstruct the workspace.

### What an in-flight RPC looks like across a transport failure

Because the rev counters drive every operation, a torn RPC is safe
to retry against a fresh session. Specifically:

- **`pushOnce`.** `pushRev` is written only after
  `assertAppliedPushCursor` succeeds. A torn push leaves `pushRev` at
  the previous value; the next push replays the same batch.
  `applyChanges` on the receiver is idempotent.
- **`pullOnce`.** The fetch cursor advances per committed batch to the
  last streamed entry's `(rev, path)`. A torn pull leaves the cursor at
  the last per-batch checkpoint; the next pull re-fetches only entries
  past that point, including within the same rev. `applyChanges`'s
  `alreadyApplied` check drops any duplicates the resume happens to
  overlap with.
- **`exec.events`.** Each event carries a monotonic `seq` per exec
  id. The client reattaches via `getExec({ id, after: seq })`.

This is why the sync protocol survives transport failures: every
operation has a persistent cursor, and every receiver is idempotent.
capnweb itself is fragile, but the protocol layered on top isn't.

### Stub disposal contract

capnweb does not garbage-collect remote stubs. A stub kept alive on
one side pins resources on the other side until the session ends or
the owning side explicitly disposes it. The protocol gives every
stub (and every result envelope returned from a method call) a
`Symbol.dispose` method; on a long-lived WebSocket session, leaks
accumulate until someone calls it.

There are two boundaries where stubs cross in this codebase, and
they have slightly different rules.

**Boundary 1: Worker / DO ↔ wsd (capnweb over WebSocket).**
This is the long-lived session described above. The driver code
(`packages/rpc/src/sync-driver.ts`, `packages/workspace/src/shell.ts`)
holds the only client-side references to result envelopes. When a
call returns `{ stream, ... }` or `{ events, ... }`, the driver
binds the envelope to a `using` variable so it disposes at the end
of the scope. Drivers also drain the inner stream before disposal
so the server side sees clean shutdown, not a cancelled stream.

For callers who use the driver helpers (`pullOnce`, `pushOnce`,
`WorkspaceShell.exec`), disposal is internal — nothing to do.
Callers who reach into `client.sync` / `client.shell` directly to
invoke streaming methods inherit the disposal contract: bind the
result to `using`, or call `result[Symbol.dispose]()` after
draining.

**Boundary 2: Worker ↔ DO (Workers RPC).** This is the boundary
`env.WSD.get(id).getWorkspace()` crosses. Returns are
`RpcTarget`-derived stubs, not plain objects. Three live across
the boundary:

- `WorkspaceStub`, returned from `getWorkspace()`.
- `WorkspaceExecHandleStub`, returned from `ws.shell.exec(...)`.
- `WorkspaceFilesystemStub` and `WorkspaceShellStub`, reached as
  properties of `WorkspaceStub` (`ws.fs`, `ws.shell`).

Worker-side callers dispose the two stubs they receive by direct
return (the first two above). The sub-stubs reached as properties
are not independently disposable in the Workers-RPC contract —
their lifetime is bounded by the parent stub. Disposing
`WorkspaceStub` cascades to its `#fs` / `#shell` children on the
DO side.

The minimal correct pattern from a Worker is:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.WSD.idFromName("user-123");
    using ws = await env.WSD.get(id).getWorkspace();

    using handle = await ws.shell.exec("npm test");
    const result = await handle.result();

    return Response.json({ exitCode: result.exitCode });
    // both `using` bindings dispose here
  },
} satisfies ExportedHandler<Env>;
```

Value-typed returns (`readFile` as a string, `stat`, `readdir`,
etc.) carry no stubs; nothing to dispose. The only things that
require `using` are values the caller stores across awaits.

For short-lived Worker requests the leak per request is bounded
and the whole session tears down with the request, so missing
`using` is observable but not fatal. The cost shows up on
long-lived isolates that keep grabbing fresh `WorkspaceStub`s
(agent loops, long-running fetch handlers) and on busy exec
workloads inside a single request.

Leak discovery is instrumented via `CAPNWEB_TRACK_STUBS=1` and
`stubSnapshot()` from `@cloudflare/workspace-rpc/debug`. wsd
exposes the snapshot at `GET /__wsd/stubs` when the flag is set;
the soak script at `script/wsd-stub-soak.mjs` and the workerd
soak at `packages/workspace/tests/stub-soak.test.ts` use it to
prove no unbounded growth under sustained workloads.

## Hibernation

> [!NOTE]
> This section describes a target architecture, not shipped code.
> Today's `CloudflareContainerBackend` uses `server.accept()`, which
> is **not** the hibernation API. The DO stays in memory for the
> lifetime of the WebSocket. Enabling hibernation requires changes
> across capnweb and the backend; the work is sketched here so the
> direction is clear.

### What hibernation gives us

Hibernatable WebSockets let the runtime evict the isolate during idle
periods *without* closing the underlying TCP connection. When traffic
arrives on the socket (or any other wake event fires), the runtime
re-instantiates the DO class, replays the relevant handler
(`webSocketMessage`, `webSocketClose`, etc.), and lets the new
incarnation handle it.

The benefit is duration-billed memory. An idle workspace — open but
not actively used — costs only storage if the DO can hibernate. With
the current `server.accept()` shape, an open `Workspace` keeps the DO
warm indefinitely.

### Why the 1:1 mapping simplifies the work

A typical hibernation-API DO multiplexes many WebSockets, and
`webSocketMessage(ws, data)` has to find the right per-WS state to
feed the frame into. With 1:1, `ctx.getWebSockets()` returns exactly
one socket; dispatch is trivial.

### What still needs solving

Two things have to change for capnweb + hibernation to work:

1. **Switch to the hibernation API.** Replace `server.accept()` with
   `ctx.acceptWebSocket(server)` in `handleFetch`. Add
   `webSocketMessage(ws, data)` and `webSocketClose(ws, ...)` methods
   on the DO class that route into capnweb. capnweb itself has to
   stop relying on `addEventListener("message", ...)` and instead
   accept frames fed in from the DO's `webSocketMessage` handler.
2. **Decide what state survives an eviction.** The DO runtime does
   *not* give us a "going to sleep" hook — eviction just happens.
   Anything needed on the other side has to be stashed proactively
   via `ws.serializeAttachment(state)` every time the value changes,
   then read back via `ws.deserializeAttachment()` on wake. The 2KB
   cap on attachment payloads is generous for what we need:

   - **capnweb's export and answer tables: nothing to store.** They
     reference live JS objects. Drop them on eviction; treat each
     wake as a fresh session. The peer must retry any in-flight RPC.
     This is the same semantics as a transport reset, which the
     protocol already handles via the rev cursors.
   - **Sync streams: nothing to store.** `pushRev` is written to
     SQLite with the pushed data it describes. The durable fetch
     cursor is written after each committed pull batch, not in the
     same transaction as the data apply. On wake, the next `pushOnce`
     / `pullOnce` reads the durable counters and resumes; any overlap
     is dropped by the idempotent apply path. No attachment write is
     required.
   - **Exec streams: store `{ [id]: seq }` per in-flight exec.**
     The `WorkspaceShell` driver inside the DO is the only place
     that knows where the consumer got to in the event stream.
     Every time it surfaces an event to the caller (or on some
     reasonable debounce) it has to update the attachment so the
     next incarnation can call `getExec({ id, after: seq })` and
     resume from the right point. A handful of exec ids with int
     seqs is tens of bytes — well under the cap.

The reason this works is that the **protocol is designed for
stream-tear-and-resume**. The rev counters live in SQLite, the exec
seqs live in `serializeAttachment`, and both are written on the
happy path so they're always current when eviction strikes. capnweb
has to learn that a session can vanish without warning, but the
protocol layered on top already speaks that language.

### When does the DO actually hibernate?

Hibernation triggers on idle. For our workload, "idle" means:

- No in-flight RPCs (each `push` / `pull` / `watermarks` is a short
  request/response; the mutation FIFO is drained).
- No active streams (`fetchChanges`'s stream is consumed and closed
  inside `pullOnce`; `pushObjects` likewise).
- No active exec (an exec emitting events keeps the DO warm via
  `webSocketMessage`).

In other words: between exec rounds, with no FS traffic, with the
push/pull FIFO empty. That is the common case for an open workspace
between agent turns, and it's exactly where hibernation pays off.

### What about the alternative — invert the dial direction?

Adopting PartySocket for reconnect/backoff would require the DO
to be the WebSocket *client* dialing `wsd`'s
`/ws` endpoint. That model is appealing for reconnect, but
hibernatable WebSockets only work server-side via
`ctx.acceptWebSocket()` — there is no hibernation API for outbound
client sockets. **Inverting the dial direction permanently forecloses
hibernation.** That trade-off is why the current recommendation
is to keep the DO as the WS server and roll a small in-house
reconnect wrapper rather than carry PartySocket.

## Cross-lifecycle interactions

The matrix below summarises how each lifecycle component reacts to
the others. Italic entries describe behaviour that depends on
items not yet shipped.

| Event | DO | Container | capnweb session |
| --- | --- | --- | --- |
| DO cold start | Born | Started if needed | Fresh session over fresh socket |
| DO restart, container alive | New incarnation | Unchanged | Fresh session over fresh socket |
| DO hibernate (future) | Isolate evicted, socket survives | Unchanged | *Fresh tables on wake; sync resumes from `_vfs_watermark`, exec resumes from `serializeAttachment` seqs* |
| DO OOM | Killed, new incarnation on next event | Unchanged (until backend rebuilds) | Dies, fresh session on next call |
| Container SIGTERM | Unchanged until next call | Restarted; in-memory VFS lost | Dies on container exit; *watermark reconcile on next connect repairs the mismatch* |
| Container OOM/kill | Unchanged until next call | Killed; restarted on next call | Same as SIGTERM |
| WebSocket idle disconnect | Unchanged | Unchanged | Dies on `close`; *reconnect wrapper rebuilds* |
| Both die (host failure) | New incarnation on next event | New container | Rev-0 baseline from DO store |

The recurring theme: **DO storage is the only durable thing in this
diagram.** Everything else is replayable from the rev counters living
in `_vfs_watermark`, provided the connect path knows how to detect
state mismatch and reset cursors. That detection is the load-bearing
durability work still to ship.

## See also

- [02. Sync Protocol](./02_sync_protocol.md) — wire format and rev
  watermark semantics.
- [07. Injected Service](./07_injected_service.md) — `wsd` boot
  sequence and the egress-interception dial-back.
- [08. Capnweb Interface](./08_capnweb_interface.md) — RPC surface
  and transport assumptions.
