// Host-side Workspace facade.
//
// Runs inside a Cloudflare Worker / Durable Object. Owns a local
// dofs Database (the host store) and a SyncRPC connection
// to wsd. Filesystem operations on Workspace.fs mutate the local
// store directly via the WorkspaceFilesystem class from
// @cloudflare/dofs; sync between the host store and wsd
// is driven explicitly via Workspace.push() / Workspace.pull().
// The shell-side pre-exec push / post-exec pull bracket lives
// on Workspace.shell.exec.

import {
  type ApplyResult,
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";
import { pullOnce, pushOnce, reconcileWatermarks } from "@cloudflare/workspace-rpc/driver";

import type { AssetsClient } from "./assets/index.js";
import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { createGitClient, type GitClient, type GitIdentity } from "./git/index.js";
import { MountIndex } from "./mounts/index.js";
import { buildMountRegistry, type MountValue } from "./mounts/registry.js";
import type { Mount } from "./mounts/types.js";
import { noopObserver, type WorkspaceObserver, withSpan } from "./observe.js";
import { WorkspaceShell } from "./shell.js";
import { WorkspaceStub } from "./stub.js";

export interface WorkspaceOptions {
  // Local store backing this Workspace. In a Durable Object, pass
  // `ctx.storage`; in tests, pass a SQLiteTestStorage from
  // @cloudflare/dofs/testing. The constructor opens a
  // Database against it and runs initializeSchema (idempotent).
  storage: DurableObjectStorageLike;

  // Backends are tried in declared order. The first one whose
  // connect() resolves wins; the rest are not consulted. Optional:
  // omit to construct a filesystem-only Workspace where the
  // SQLite-backed fs surface is fully usable but the shell half
  // throws a clear error on access.
  backends?: WorkspaceBackend[];

  // Clock used for mtime / last_seen on local FS writes. Defaults
  // to Date.now. Override for deterministic tests.
  now?: () => number;

  // Identifier for this workspace / session. Forwarded to mount
  // factories via MountContext.sessionId. Optional; defaults to "".
  sessionId?: string;

  // Mounts to register against the workspace. Keys are absolute
  // mount roots (no trailing slash, no nesting). Values are either
  // bare Mount objects or factories that take a MountContext and
  // return one. Factories are called once at construction.
  mounts?: Record<string, MountValue>;

  // Observer that receives one span per workspace operation: a
  // `workspace.connect` per backend connect attempt,
  // `workspace.sync.push` / `workspace.sync.pull` per sync call,
  // `workspace.shell.exec` per exec, and `workspace.fs.<op>` per
  // filesystem call routed through the stub. The default is a
  // no-op so the package has no observability cost when callers
  // do not opt in. See `./observe.ts` for the contract and the
  // adapter subpaths for the Cloudflare runtime and OpenTelemetry.
  observer?: WorkspaceObserver;

  // Default identity used by commit-producing git subcommands
  // when neither the call site nor the relevant `GIT_AUTHOR_*` /
  // `GIT_COMMITTER_*` env vars supply one. Threaded through to
  // `createGitClient` on first access to `workspace.git`.
  defaultGitIdentity?: GitIdentity;

  // Optional assets publisher used by WorkspaceStub and the worker
  // backend's `assets publish` shell command. Pass an AssetsClient
  // directly, or a factory when the publisher needs the Workspace
  // instance itself (for example, createAssets({ ws, ... })).
  assets?: AssetsClient | ((ws: Workspace) => AssetsClient);
}

export class Workspace {
  readonly #db: Database;
  readonly #fs: WorkspaceFilesystem;
  /**
   * Lazily-constructed dofs provider. Built on first `provider()`
   * call; cached so repeated callers share the same instance.
   */
  #provider: SQLiteWorkspaceProvider | undefined;
  readonly #backends: WorkspaceBackend[];
  readonly #backendsById: Map<string, WorkspaceBackend>;
  readonly #defaultBackendId: string | undefined;
  readonly #observer: WorkspaceObserver;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #defaultGitIdentity: GitIdentity | undefined;
  readonly #assets: AssetsClient | undefined;
  // Lazily-constructed git client, cached so the dynamic
  // imports of isomorphic-git / diff land once per Workspace.
  #git: GitClient | undefined;
  readonly #mounts: Map<string, Mount>;
  readonly #mountIndex: MountIndex;
  // Per-backend handle cache. Filled lazily on first use of each
  // backend; a closed transport drops just that backend's entry,
  // leaving the others warm.
  readonly #handles = new Map<string, BackendHandle>();
  // In-flight connect promises keyed by backend id, so concurrent
  // callers for the same backend share one connect pass.
  readonly #connecting = new Map<string, Promise<BackendHandle>>();
  // Per-backend WorkspaceShell facades. Constructed alongside each
  // handle; reused for the life of the handle.
  readonly #shells = new Map<string, WorkspaceShell>();
  #readyPromise: Promise<void> | undefined;
  // Per-backend FIFOs that serialize mutating entry points (push,
  // pull, and the shell exec bracket which goes through them) for
  // that backend. A push to backend A does not block exec on
  // backend B. Reads bypass the queue entirely — they hit the
  // local store directly through Workspace.fs. Each value is a
  // single tail-promise; each caller chains its work onto the tail
  // and updates it. See docs/02 "Concurrent mutators".
  readonly #mutationTails = new Map<string, Promise<unknown>>();

  constructor(options: WorkspaceOptions) {
    this.#now = options.now ?? Date.now;
    this.#sessionId = options.sessionId ?? "";
    this.#defaultGitIdentity = options.defaultGitIdentity;
    this.#db = new Database(options.storage);
    initializeSchema(this.#db, this.#now);
    this.#fs = new WorkspaceFilesystem(this.#db, { now: this.#now });
    this.#backends = (options.backends ?? []).slice();
    // Reject duplicate backend ids at construction. The Workspace
    // selects backends by id at exec / push / pull time; two
    // backends sharing a string would make the selector
    // non-deterministic in a way that's almost certainly a
    // configuration bug.
    this.#backendsById = new Map();
    for (const backend of this.#backends) {
      if (this.#backendsById.has(backend.id)) {
        throw new Error(
          `Workspace: duplicate backend id ${JSON.stringify(backend.id)}. ` +
            "Pass an explicit `id` on each backend's constructor options to " +
            "distinguish them.",
        );
      }
      this.#backendsById.set(backend.id, backend);
    }
    this.#defaultBackendId = this.#backends[0]?.id;
    this.#observer = options.observer ?? noopObserver;
    this.#mounts = buildMountRegistry(options.mounts, {
      sessionId: options.sessionId,
      vfs: () => this.provider(),
    });
    this.#mountIndex = new MountIndex({
      db: this.#db,
      fs: this.#fs,
      mounts: this.#mounts,
    });
    this.#assets = typeof options.assets === "function" ? options.assets(this) : options.assets;
  }

  // Force every registered mount to materialize. Idempotent; safe to
  // call from multiple places (ready(), tests, future fs/shell
  // entry points). Concurrent callers share one materialize() pass
  // per mount.
  ensureMountsIndexed(): Promise<void> {
    return this.#mountIndex.ensureIndexed();
  }

  // Resolved mount registry, keyed by absolute mount root. Returned
  // as a defensive copy so callers can't mutate the internal map.
  mounts(): Map<string, Mount> {
    return new Map(this.#mounts);
  }

  // Local store. Exposed for tests / diagnostics and for the
  // sync helpers that take a Database directly.
  get db(): Database {
    return this.#db;
  }

  // Observer used to wrap workspace operations in spans. Exposed for the
  // stub and shell facades, which need to wrap their own entry points in
  // spans named after the boundary the caller crossed. Defaults to a
  // no-op when the constructor did not receive one.
  get observer(): WorkspaceObserver {
    return this.#observer;
  }

  // Filesystem facade — the documented Workspace.fs surface from
  // docs/04. Available immediately; doesn't need ready() because
  // reads and writes hit the local store, not the wire.
  //
  // Read-only mount enforcement lives at the data layer in
  // @cloudflare/dofs: writeFile / mkdir / rm consult the registered
  // mount roots and reject EROFS without needing a workspace-side
  // wrapper. The same check fires on the apply path used by
  // pullOnce, so container-side writes under a read-only mount are
  // also rejected (and surfaced via Workspace.pull's skipped[]).
  get fs(): WorkspaceFilesystem {
    return this.#fs;
  }

  // Identifier for this workspace / session, as passed to the
  // constructor. Empty string when the caller did not supply one.
  // Forwarded to mount factories and used by the assets module to
  // tag shared objects with their originating session.
  get sessionId(): string {
    return this.#sessionId;
  }

  // Optional assets publisher. Exposed through WorkspaceStub so
  // the worker backend's shell can run `assets publish` without
  // receiving R2 bindings or signing secrets in the Dynamic Worker.
  get assets(): AssetsClient | undefined {
    return this.#assets;
  }

  // Git facade. Available immediately and does not require a
  // backend — every supported subcommand reads and writes through
  // the local SQLite-backed VFS. The dynamic imports for
  // isomorphic-git / diff are deferred until the first method on
  // the returned client is awaited; touching `workspace.git`
  // itself is cheap.
  //
  // Memoised on a private field so repeated callers share the
  // pack/index cache and the resolved peer-dep modules.
  get git(): GitClient {
    if (!this.#git) {
      this.#git = createGitClient({
        ws: this,
        defaultIdentity: this.#defaultGitIdentity,
      });
    }
    return this.#git;
  }

  /**
   * Underlying dofs `SQLiteWorkspaceProvider` over the local store.
   *
   * This is the `@platformatic/vfs`-shaped provider — a node:fs
   * surface with full symlink support. Callers that want a
   * `VirtualFileSystem` (e.g. to hand to isomorphic-git) wrap it
   * themselves to keep `@platformatic/vfs` out of this package's
   * dependency tree:
   *
   * ```ts
   * import { create, VirtualProvider } from "@platformatic/vfs";
   * import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
   *
   * class Glue extends VirtualProvider {
   *   constructor(private inner: SQLiteWorkspaceProvider) { super(); }
   *   override get readonly()         { return this.inner.readonly; }
   *   override get supportsSymlinks() { return this.inner.supportsSymlinks; }
   *   override get supportsWatch()    { return this.inner.supportsWatch; }
   * }
   * // Forward every node:fs method to `inner` via a
   * // `for (const name of [...]) Object.defineProperty(...)` loop.
   * const vfs = create(new Glue(workspace.provider()));
   * ```
   *
   * Available immediately; doesn't need `ready()` because the
   * provider only reads/writes the local store, not the wire.
   */
  provider(): SQLiteWorkspaceProvider {
    if (!this.#provider) {
      this.#provider = new SQLiteWorkspaceProvider(this.#db, { now: this.#now });
    }
    return this.#provider;
  }

  // Shell facade. Throws if no backend was configured (the
  // Workspace was constructed for filesystem-only use).
  //
  // The returned facade is a router: each method picks the right
  // backend (the default, or one named through ExecOptions.backend)
  // and forwards to that backend's ShellRPC. Backend connect is
  // lazy — the first exec / get for a backend dials it.
  get shell(): WorkspaceShell {
    if (this.#backends.length === 0) {
      throw new Error(
        "Workspace has no backend configured — the shell is not available. " +
          "Pass `backends` to the Workspace constructor to enable shell.exec.",
      );
    }
    return this.#routedShell();
  }

  // ensureMountsIndexed() is the only thing ready() does today;
  // backends connect lazily on first use. The promise is still
  // cached so concurrent ready() calls share one index pass; a
  // failed pass is uncached so the next call retries.
  //
  // Pass an explicit backend id to pre-warm one. Pass
  // `{ all: true }` to dial every backend in parallel — useful
  // from an agent's `onStart` hook.
  ready(options?: string | { all?: boolean }): Promise<void> {
    if (this.#readyPromise === undefined) {
      const pass = this.#mountIndex.ensureIndexed();
      this.#readyPromise = pass;
      pass.catch(() => {
        // A failed mount-index pass must not poison this
        // Workspace forever. The next ready() should re-enter
        // ensureIndexed() and try again.
        if (this.#readyPromise === pass) this.#readyPromise = undefined;
      });
    }
    const indexPromise = this.#readyPromise;
    if (options === undefined) return indexPromise;
    if (typeof options === "string") {
      const id = options;
      return (async () => {
        await indexPromise;
        await this.#handleFor(id);
      })();
    }
    if (options.all) {
      return (async () => {
        await indexPromise;
        await Promise.all(this.#backends.map((b) => this.#handleFor(b.id)));
      })();
    }
    return indexPromise;
  }

  // Wrap this workspace in a WorkspaceStub so it can be handed
  // across the Workers-RPC boundary (e.g. returned from a DO RPC
  // method). The stub is a lazy RpcTarget — it doesn't own any
  // resources itself; it just delegates back to this workspace.
  stub(): WorkspaceStub {
    return new WorkspaceStub(this);
  }

  // Sync the local store with a configured backend.
  //
  // push() ships everything the host has written since the last
  // push to that backend; pull() applies everything the backend
  // has produced since the last pull. Both are explicit — the
  // package doesn't run a background loop. WorkspaceShell.exec
  // brackets each call automatically against the backend it
  // selects; reach for push() / pull() directly only when an
  // FS-only flow needs the bracket without an exec.
  //
  // `id` selects which backend to push to / pull from. Omitting
  // it picks the default (the first backend in the list).
  //
  // push() returns the number of entries shipped to the backend.
  // pull() returns the dofs ApplyResult { applied, skipped } —
  // `applied` is the number of entries written into the local
  // store, `skipped` surfaces remote-side writes the apply path
  // rejected because they targeted a read-only mount root.
  //
  // Both methods emit a `workspace.sync.push` / `workspace.sync.pull`
  // span on the configured observer, tagged with the resolved
  // backend id and the entry count.
  push(id?: string): Promise<number> {
    return this.#serialize(id, (resolvedId) =>
      withSpan(
        this.#observer,
        "workspace.sync.push",
        { "workspace.sync.backend": resolvedId },
        async () => {
          if (resolvedId === undefined) return 0;
          const handle = await this.#handleFor(resolvedId);
          // A backend that reuses the host store as its sole
          // source of truth has nothing to ship and no remote to
          // ship to. Short-circuit so the shell exec bracket can
          // keep calling push() unconditionally without paying
          // for it.
          if (handle.sync === "none") return 0;
          return pushOnce(this.#db, handle.rpc.sync, resolvedId);
        },
        (span, outcome) => {
          if (outcome.ok) span.setAttribute("workspace.sync.pushed", outcome.value);
        },
      ),
    );
  }

  pull(id?: string): Promise<ApplyResult> {
    return this.#serialize(id, (resolvedId) =>
      withSpan(
        this.#observer,
        "workspace.sync.pull",
        { "workspace.sync.backend": resolvedId },
        async () => {
          if (resolvedId === undefined) return { applied: 0, skipped: [] };
          const handle = await this.#handleFor(resolvedId);
          if (handle.sync === "none") return { applied: 0, skipped: [] };
          return pullOnce(this.#db, handle.rpc.sync, resolvedId);
        },
        (span, outcome) => {
          if (!outcome.ok) return;
          span.setAttribute("workspace.sync.applied", outcome.value.applied);
          span.setAttribute("workspace.sync.skipped", outcome.value.skipped.length);
        },
      ),
    );
  }

  // Per-backend mutation FIFO. The shell exec bracket
  // (push → spawn → pull) and the public push() / pull() methods
  // route through this; reads bypass it entirely. A push to
  // backend A does not block exec on backend B because each id
  // gets its own tail-promise. The undefined id (filesystem-only
  // path through push/pull) shares one slot.
  //
  // Rejections are not contagious: the catch arm here swallows
  // failures so a failing mutation doesn't poison the rest of
  // the queue — the caller still sees the original rejection
  // through the returned promise.
  #serialize<T>(
    id: string | undefined,
    fn: (resolvedId: string | undefined) => Promise<T>,
  ): Promise<T> {
    const resolved = this.#resolveBackendId(id);
    const slot = resolved ?? "";
    const tail = this.#mutationTails.get(slot) ?? Promise.resolve();
    const run = tail.then(
      () => fn(resolved),
      () => fn(resolved),
    );
    this.#mutationTails.set(
      slot,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // Resolve an exec / push / pull caller's id argument to a
  // concrete backend id. Returns undefined for a filesystem-only
  // workspace; throws on an unknown id. Omitted ids fall through
  // to the first backend in the list (the default).
  #resolveBackendId(id: string | undefined): string | undefined {
    if (this.#backends.length === 0) return undefined;
    const target = id ?? this.#defaultBackendId;
    if (target === undefined) return undefined;
    if (!this.#backendsById.has(target)) {
      throw new Error(
        `Workspace: no backend with id ${JSON.stringify(target)}. ` +
          `Configured backends: ${[...this.#backendsById.keys()].map((k) => JSON.stringify(k)).join(", ") || "<none>"}.`,
      );
    }
    return target;
  }

  async close(): Promise<void> {
    // Close every cached handle in parallel. Drop caches before
    // awaiting so a subsequent ready() / exec sees an empty slate
    // and rebuilds against fresh handles.
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    this.#shells.clear();
    this.#connecting.clear();
    this.#readyPromise = undefined;
    await Promise.all(
      handles.map(async (h) => {
        try {
          await h.close();
        } catch {
          // close() is best-effort; a transport that's already
          // gone shouldn't take the workspace down with it.
        }
      }),
    );
  }

  // Lazy backend connect. Concurrent callers for the same id
  // share one in-flight promise. The resolved handle is cached
  // until close() or the backend's `closed` promise fires.
  #handleFor(id: string): Promise<BackendHandle> {
    const cached = this.#handles.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = this.#connecting.get(id);
    if (inflight !== undefined) return inflight;
    const backend = this.#backendsById.get(id);
    if (backend === undefined) {
      return Promise.reject(new Error(`Workspace: no backend with id ${JSON.stringify(id)}`));
    }
    const promise = (async () => {
      const handle = await withSpan(
        this.#observer,
        "workspace.connect",
        { "workspace.backend.id": id, "workspace.backend.type": backend.type },
        () => backend.connect(),
      );
      // Reconcile watermarks before publishing the handle. If the
      // remote restarted between our pushes / fetches it has lost
      // state we thought it had; reset the local cursors so the
      // next tick rebaselines.
      //
      // A backend that declares sync: "none" has no remote store
      // to reconcile against; skip the pass entirely.
      if (handle.sync !== "none") {
        await reconcileWatermarks(this.#db, handle.rpc.sync, id);
      }
      this.#handles.set(id, handle);
      // Watch the transport for mid-session loss. Backends without
      // a `closed` promise (in-process fakes) opt out by omitting
      // it; we only react when it's wired.
      if (handle.closed) {
        handle.closed
          .catch(() => {})
          .then(() => {
            // Only clear if this handle is still the current one
            // for this id. A close() that already ran will have
            // dropped the entry; a subsequent #handleFor may have
            // installed a new one.
            if (this.#handles.get(id) === handle) {
              this.#handles.delete(id);
              this.#shells.delete(id);
            }
          });
      }
      return handle;
    })().finally(() => {
      // Always drop the in-flight entry so a failed connect can
      // be retried by the next call.
      this.#connecting.delete(id);
    });
    this.#connecting.set(id, promise);
    return promise;
  }

  // Per-backend WorkspaceShell, constructed on demand and cached
  // for the life of the handle.
  async #shellFor(id: string): Promise<WorkspaceShell> {
    const cached = this.#shells.get(id);
    if (cached !== undefined) return cached;
    const handle = await this.#handleFor(id);
    const existing = this.#shells.get(id);
    if (existing !== undefined) return existing;
    const shell = new WorkspaceShell(
      handle.rpc.shell,
      {
        push: () => this.push(id),
        pull: () => this.pull(id),
      },
      this.#observer,
    );
    this.#shells.set(id, shell);
    return shell;
  }

  // Routed shell facade. Each method picks the right backend per
  // call (default, or the one named through ExecOptions.backend)
  // and forwards to that backend's WorkspaceShell.
  #routedShell(): WorkspaceShell {
    const router = new WorkspaceShellRouter(
      this.#defaultBackendId ?? "",
      (id) => this.#shellFor(id),
      (id) => this.#resolveBackendId(id) ?? "",
    );
    return router as unknown as WorkspaceShell;
  }
}

// Selector wrapper that satisfies the WorkspaceShell surface but
// resolves the underlying ShellRPC per call. ExecOptions and
// GetExecOptions both gain an optional `backend` field; when
// present the router routes the call to that backend's
// WorkspaceShell, otherwise it routes to the default.
//
// Implemented as a non-extending class with the same method
// names so the routed object slots into every callsite that
// expects a WorkspaceShell without having to thread the union
// type through.
class WorkspaceShellRouter {
  readonly #defaultId: string;
  readonly #shellFor: (id: string) => Promise<WorkspaceShell>;
  readonly #resolveId: (id: string | undefined) => string;

  constructor(
    defaultId: string,
    shellFor: (id: string) => Promise<WorkspaceShell>,
    resolveId: (id: string | undefined) => string,
  ) {
    this.#defaultId = defaultId;
    this.#shellFor = shellFor;
    this.#resolveId = resolveId;
  }

  async exec(command: string, options: { backend?: string } & Record<string, unknown> = {}) {
    const id = this.#resolveId(options.backend) || this.#defaultId;
    const shell = await this.#shellFor(id);
    const { backend: _backend, ...rest } = options;
    return (shell.exec as unknown as (c: string, o: typeof rest) => unknown)(command, rest);
  }

  async get(id: string, options: { backend?: string } & Record<string, unknown> = {}) {
    const backendId = this.#resolveId(options.backend) || this.#defaultId;
    const shell = await this.#shellFor(backendId);
    const { backend: _backend, ...rest } = options;
    return (shell.get as unknown as (e: string, o: typeof rest) => unknown)(id, rest);
  }
}
