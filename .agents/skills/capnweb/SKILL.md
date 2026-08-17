---
name: capnweb
description: |
  capnweb RPC patterns for this repo, with a heavy focus on stub lifecycle
  and disposal. Load when touching anything that crosses the Durable Object
  ↔ computerd boundary: packages/rpc, packages/computer, the computerd client, or the
  Durable Object server. Triggers include "capnweb", "RpcTarget", "stub",
  "RPC wire", "promise pipelining", "stub disposal", "RpcPromise".
---

# capnweb in this repo

[capnweb](https://github.com/cloudflare/capnweb) is the RPC framing
between the Durable Object and `computerd`. It's an object-capability RPC
system with promise pipelining, structured-clone-style transfer of
stubs, and bidirectional calls. The wire format used here is text
JSON over a long-lived WebSocket. That is the only carrier: capnweb's
HTTP batch transport cannot deliver a stream returned from a call,
which is what every read on this interface is.

## Where things live

- [`packages/rpc/src/interface.ts`](../../../packages/rpc/src/interface.ts)
  — typed wire surface. `WorkspaceRPC` is the root stub and composes
  `SyncRPC` and `ShellRPC`. Add new methods here first.
- [`packages/rpc/src/server.ts`](../../../packages/rpc/src/server.ts)
  — `Database`-backed implementation. Imported by the Durable Object
  and the in-container computerd.
- [`packages/rpc/src/client.ts`](../../../packages/rpc/src/client.ts)
  — typed stubs over a WebSocket carrier. The Durable Object uses a
  deferred transport so the stub can be created before the upgrade
  completes.
- [`packages/rpc/src/sync-driver.ts`](../../../packages/rpc/src/sync-driver.ts)
  — `pullOnce`, `pushOnce`, `tick`. These wrap streaming methods and
  handle disposal internally.
- [`packages/rpc/src/debug.ts`](../../../packages/rpc/src/debug.ts)
  — `enableStubTracking`, `stubSnapshot` for leak hunting.
- [`docs/08_capnweb_interface.md`](../../../docs/08_capnweb_interface.md)
  — design intent for the wire.
- [`docs/11_lifecycle.md`](../../../docs/11_lifecycle.md#stub-disposal-contract)
  — the repo's stub disposal contract.

## The mental model

A stub is a **capability**: holding it is the right to call the
remote object. Stubs are not garbage-collected across the network —
the local GC has no visibility into the remote object graph, and the
remote runtime has no idea whether you're under memory pressure. If
you don't explicitly dispose stubs, you leak resources on the other
side of the connection.

This matters more here than in many capnweb deployments because the
connection is **long-lived**. A short-lived session disposes everything
when it ends; our WebSocket between the Durable Object and `computerd`
stays up for the lifetime of the workspace, so every undisposed stub
stays alive until that connection drops.

## The caller-disposes rule

The fundamental principle, from the capnweb spec:

> **The caller is responsible for disposing all stubs.**

Concretely:

- **Stubs passed in parameters** remain owned by the caller. The
  callee receives duplicates that the RPC system auto-disposes when
  the call completes. You can dispose your originals immediately
  after the call — they were duplicated at send time.
- **Stubs returned in results** transfer ownership to the caller.
  The caller must dispose them. The RPC system disposes the callee's
  duplicates once it knows no more pipelined calls will land.
- **Result envelopes always have a disposer**, even if you don't
  think they contain stubs. Dispose them anyway — a future API
  change may add stubs and your caller will silently leak.

## How to dispose

Three patterns, in order of preference:

```ts
// 1. `using` declaration — preferred when the stub is scope-local.
using result = await client.sync.fetchChanges({ sinceRev });
for await (const entry of result.stream) {
  // ...
}
// result is disposed when the block exits.
```

```ts
// 2. try/finally — when `using` isn't available or the scope is awkward.
const result = await client.sync.fetchChanges({ sinceRev });
try {
  for await (const entry of result.stream) {
    // ...
  }
} finally {
  result[Symbol.dispose]();
}
```

```ts
// 3. Explicit dispose — when ownership crosses a boundary.
const stub = api.getThing();
// ... pass `stub` somewhere ...
stub[Symbol.dispose]();
```

## Repo-specific disposal contract

- **Drivers own their stubs.** `pullOnce` and `pushOnce` dispose
  every envelope they touch. Code that goes through the driver
  doesn't need to think about it.
- **Direct streaming calls own their result.** If you reach into
  `client.sync` / `client.shell` directly to call `fetchChanges`,
  `fetchObjects`, `shell.exec`, or `shell.getExec`, you own the
  envelope. Bind it with `using` or dispose in `finally`. The stream
  on the envelope is the body; draining it does not release the
  envelope itself.
- **Closing disposes the root.** `createSyncClient` /
  `createWorkspaceClient` dispose the root stub when you call
  `client.close()`. Don't tear down the underlying WebSocket
  yourself; let `close()` cascade.
- **Don't await a stub just to inspect it.** Awaiting an
  `RpcPromise` resolves it; if it resolves to a stub, you now own
  that stub and must dispose it.

## Duplicating stubs with `.dup()`

If you need to pass a stub somewhere that will dispose it but also
want to keep using it locally, call `stub.dup()`. The underlying
target stays alive until every duplicate is disposed.

`.dup()` also works on a property of a stub or promise. This is the
idiomatic way to grab a stub-shaped property without an extra round
trip:

```ts
// Grab `authedApi` as a stub immediately, without awaiting.
using authedApi = api.authenticate(token).dup();
// Use it for pipelined calls right away.
const userId = await authedApi.getUserId();
```

## Listening for disposal on the server

An `RpcTarget` may declare a `Symbol.dispose` method. capnweb calls
it once every stub pointing at the target has been disposed.

```ts
class SessionTarget extends RpcTarget {
  // ...
  [Symbol.dispose]() {
    // Release any per-session resources.
  }
}
```

If you pass the same target to RPC multiple times, you get one
dispose call per stub. To collapse them into one, wrap the target in
`new RpcStub(target)` once and pass that stub around instead.

## Listening for disconnect

`stub.onRpcBroken(cb)` fires when the stub becomes unusable —
typically because the underlying connection dropped or, for a
promise, because the promise rejected. After the callback runs every
method call on that stub will throw. `packages/computer` already
folds `onRpcBroken` into the workspace's closed promise; reuse that
plumbing rather than wiring up a parallel listener.

## Promise pipelining

An `RpcPromise` is also a stub for its eventual result. Don't await
unless you actually need the value locally:

```ts
// Three calls, one round trip.
using authed = api.authenticate(token).dup();
const profile = await api.getUserProfile(authed.getUserId());
```

You can pass an `RpcPromise` as an argument to another RPC. capnweb
substitutes the resolved value on the receiver side before
delivering the call.

Property access on a stub or promise returns an `RpcPromise` **that
does not have its own disposer** — you must dispose the stub or
promise it came from. You can pass a property in params or returns,
but doing so never causes anything to be implicitly disposed.

## The magic `.map()`

`.map()` runs a sync callback on the remote resolution of a promise,
in one round trip:

```ts
const idsPromise = api.listUserIds();
const names = await idsPromise.map(id => [id, api.getUserName(id)]);
```

Restrictions:

- The callback must be synchronous (no `await`).
- The callback runs in record mode locally first, so it must have no
  side effects beyond RPC calls.
- Any stubs captured by the callback are sent to the peer along with
  the recording. Treat captured stubs as exposed to the peer; only
  use stubs that originated from the same peer.

## Streams are first-class

`ReadableStream<T>` is a regular capnweb value. The wire never
inlines blob bytes — change streams carry content-addressed
`(hash, size)` records and the receiver calls back via `hasObjects`
/ `pushObjects` for the missing subset. Prefer streaming over single
large payloads when adding new RPCs.

When you receive a streaming result, the envelope owns the stream.
Draining the stream does not dispose the envelope; dispose the
envelope to release every stub it contains.

## Do / don't

- **Do** define new methods on `WorkspaceRPC` in `interface.ts`
  before implementing them on either side.
- **Do** treat stubs as capabilities. Don't pass them across session
  boundaries unless you mean to grant access.
- **Do** drive sync rounds through `pullOnce` / `pushOnce` when you
  can.
- **Do** declare `using` on every awaited result envelope from a
  direct streaming call.
- **Do** dispose result envelopes even when you don't think they
  contain stubs — futureproofing is cheap.
- **Do** call `.dup()` rather than awaiting twice when you need a
  stub copy to outlive a callee's auto-dispose.
- **Do** run the leak harness (`script/computerd-stub-soak`) when you
  change anything around RPC lifecycle, and check
  `session.getStats()` for drift.
- **Don't** send binary WebSocket frames. The wire is text JSON.
- **Don't** tear down the underlying carrier directly. Always go
  through `client.close()` so the root stub disposes first.
- **Don't** mutate the `WorkspaceRPC` interface without updating
  both sides — the wire contract is shared.
- **Don't** declare a method `private` in TypeScript and assume it's
  hidden from RPC. Use a `#`-prefixed name to actually make it
  private at runtime.
- **Don't** rely on garbage collection to clean up stubs. It won't.

## Testing for leaks

- Use `enableStubTracking()` + `stubSnapshot()` in a test to assert
  no stub survives a round trip you expected to clean up.
- Soak the boundary with `script/computerd-stub-soak` for
  disposal-sensitive changes; it reads `session.getStats()` to
  detect drift.
- Server-side RPC behavior is tested against the real `Database`
  and real driver helpers in `packages/rpc` and `packages/computer`.

## Further reading

- [capnweb on GitHub](https://github.com/cloudflare/capnweb) — the
  upstream README is the authoritative reference for stub
  ownership, `.dup()`, `.map()`, and transport semantics.
- [`docs/08_capnweb_interface.md`](../../../docs/08_capnweb_interface.md)
- [`docs/11_lifecycle.md`](../../../docs/11_lifecycle.md)
- [`packages/rpc/README.md`](../../../packages/rpc/README.md)
