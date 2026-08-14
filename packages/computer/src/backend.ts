// A backend produces a connection to a shell runtime. The
// Workspace constructor takes a set of backends keyed by `id`;
// `Workspace.runtime.exec("...", { backend })` picks one by id.
// `id` is user-supplied so the same shape can host multiple
// instances of the same backend kind (two workers on different
// loaders, a worker + a container side by side, ...). `type`
// is the kind itself: a small diagnostic string the backend
// hard-codes for tracing and stub-leak counters.
//
// Backends do not own the underlying runtime's lifecycle beyond
// the handle they hand back. close() on the BackendHandle tears
// down whatever the backend created on connect() (the SyncRPC
// stub, the container, etc.); a backend that doesn't own a
// container (TestBackend) only closes the stub.
//
// The interface stays narrow on purpose. Anything wire-specific
// (sync, exec, ...) sits on the returned rpc stub. Backends do
// not see method signatures; they only produce handles and tear
// them down.

import type { WorkspaceRPC } from "@cloudflare/computer-rpc";

// The handles the Workspace owns and injects into a backend when
// it connects. The Workspace constructor builds `db`/`fs` itself,
// after the caller has already constructed the backends and passed
// them in, so a backend cannot capture them at its own
// construction time. `connect(host)` is how the Workspace hands
// over the storage-layer handles once they exist. Shell and
// container backends ignore the bag (they reach the host through
// their own transport); the in-process module backend uses it.
export interface WorkspaceBackendHost {
  readonly db: import("@cloudflare/dofs").Database;
  readonly fs: import("@cloudflare/dofs").WorkspaceFilesystem;
  readonly git: import("./git/index.js").GitClient;
  readonly artifacts: import("./artifacts/index.js").ArtifactClient;
}

export interface WorkspaceBackend {
  // User-supplied selector. Passed in `ExecOptions.backend` and
  // `Workspace.push(id)` / `Workspace.pull(id)` to address this
  // backend. The Workspace constructor rejects duplicate ids.
  //
  // Each concrete backend constructor accepts an `id` option
  // and defaults it to a sensible string when omitted: "test"
  // for TestBackend, "container-shell" for the container
  // backend, and "worker-shell" for the worker shell backend. Single-backend
  // setups can ride the default and never touch the field.
  readonly id: string;

  // Diagnostic kind of backend, fixed by the implementation
  // ("test", "cloudflare-container", "worker-shell"). Used for
  // tracing spans and stub-leak counters; not consumed by
  // Workspace selection logic.
  readonly type: string;

  // Whether the backend accepts a structured `input` value and
  // returns a structured `result` value. Independent of the
  // implementation kind: a shell backend that coerces JSON to
  // argv/stdin and parses stdout back to a value can be callable
  // too. Defaults to false when omitted.
  readonly callable?: boolean;

  // Materialise a connection. Called lazily on first use, once
  // per backend per workspace lifetime. The Workspace caches the
  // resulting handle by `id`; subsequent exec / push / pull
  // calls reuse it. The Workspace always passes its host bag;
  // backends that reach the host through their own transport
  // ignore it.
  connect(host: WorkspaceBackendHost): Promise<BackendHandle>;
}

export interface BackendHandle {
  // The composite WorkspaceRPC stub pointing at the computerd
  // backend produced.
  rpc: WorkspaceRPC;
  // Durable identity of the runtime process behind this connection.
  // Reconnecting to the same process preserves it; a replacement
  // process receives a new id. Backends without process-local state
  // may omit it.
  runtimeId?: string;
  // Declares whether this backend pairs with an independent
  // remote store that the Workspace must sync against.
  //
  //   "remote" — the default. A computerd-style backend with its own
  //              SQLite-backed VFS; push/pull move entries between
  //              the host store and that remote.
  //   "none"   — the backend reuses the host store as its sole
  //              source of truth (a Worker-isolate shell whose
  //              filesystem operations call back into the same
  //              Durable Object). push/pull are no-ops, and the
  //              reconcile-watermarks pass on connect is skipped.
  sync?: "remote" | "none";
  // Resolves when the underlying transport closes for any reason
  // (clean close, peer crash, network drop). The Workspace listens
  // for this and drops its cached handle so the next ready() call
  // re-enters connect() against a fresh transport. Optional for
  // backends whose transport can't drop mid-session (e.g. an
  // in-process fake); when omitted, the Workspace keeps the handle
  // until close() is called explicitly.
  closed?: Promise<void>;
  // Tear down the connection. Idempotent. The Workspace calls
  // close() during its own close(); backend authors don't need
  // to handle re-entry.
  close(): Promise<void>;
}
