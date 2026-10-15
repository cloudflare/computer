# `@cloudflare/computer-rpc`

> [!IMPORTANT]
> **Experimental.** This package is provided for feedback only. Its APIs
> may change in any release, and it is not suitable for production use
> yet. Suitable for experiments, exploration, and prototypes. See the
> [`@cloudflare/computer` status table](../computer/README.md#status)
> for which components are stable.
>
> The specification under [`docs/`](../../docs/README.md) is forward-looking — read it for
> intent, not as description of the code today.

capnweb-based RPC wire types and server/client helpers shared
between the DO and `computerd`. The package is split into four entry
points:

- `.` — the typed wire interface (`SyncRPC`, `ShellRPC`,
  `WorkspaceRPC`, `WireError`).
- `./server` — a `Database`-backed implementation. Imported by
  DO code and by the in-container computerd.
- `./client` — typed stubs over a WebSocket carrier.
- `./driver` — `pullOnce` / `pushOnce` / `tick` helpers that
  drive a SyncRPC client through a sync round.
- `./debug` — leak-discovery helpers (`stubSnapshot`,
  `enableStubTracking`, `isStubTrackingEnabled`).

## Stub disposal

The driver helpers (`pullOnce`, `pushOnce`) handle disposal of
capnweb result envelopes internally — callers that use them
don't have to think about it.

Callers that reach into `client.sync` / `client.shell` directly
to invoke streaming methods (`fetchChanges`, `fetchObjects`,
`shell.exec`, `shell.getExec`) inherit the disposal contract.
Either bind the awaited result to a `using` variable, or call
`result[Symbol.dispose]()` after draining the stream.

The closing path on `createSyncClient` / `createWorkspaceClient`
already disposes the root stub before tearing down the
underlying WebSocket; calling `client.close()` is enough.

See [`docs/11_lifecycle.md`](../../docs/11_lifecycle.md#stub-disposal-contract)
for the full contract.

## Debug surface

```ts
import {
  enableStubTracking,
  isStubTrackingEnabled,
  stubSnapshot,
} from "@cloudflare/computer-rpc/debug";

// Either set CAPNWEB_TRACK_STUBS=1 in the environment, or call
// enableStubTracking() at module init in runtimes (like workerd)
// that don't surface env vars on process.env or globalThis.
enableStubTracking();

// Per-class live counter for every RpcTarget this package owns.
console.log(stubSnapshot());
```

The counter is opt-in and has no cost when disabled. `computerd`
exposes the snapshot at `GET /__computerd/stubs` when tracking is on.
