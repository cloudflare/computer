// Host-side Workspace facade.
//
// Runs inside a Cloudflare Worker / Durable Object. Owns a local
// dofs Database (the host store) and a SyncRPC connection
// to computerd. Filesystem operations on Workspace.fs mutate the local
// store directly via the WorkspaceFilesystem class from
// @cloudflare/dofs; sync between the host store and computerd
// is driven explicitly via Workspace.push() / Workspace.pull().
// Command-backend pre-exec push / post-exec pull brackets are
// routed through Workspace.runtime.exec.

import { pullOnce, pushOnce, reconcileWatermarks } from "@cloudflare/computer-rpc/driver";
import {
  type ApplyResult,
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  SQLiteWorkspaceProvider,
  WorkspaceFilesystem,
} from "@cloudflare/dofs";

import {
  type ArtifactClient,
  ArtifactError,
  createArtifact,
  runArtifactsCLI,
} from "./artifacts/index.js";
import type { AssetsClient } from "./assets/index.js";
import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import type { GitClient, GitClientFactory, GitIdentity } from "./git/index.js";
import { MountIndex } from "./mounts/index.js";
import { buildMountRegistry, type MountValue } from "./mounts/registry.js";
import type { Mount } from "./mounts/types.js";
import { noopObserver, safeErrorMessage, type WorkspaceObserver, withSpan } from "./observe.js";
import { WorkspaceRuntime } from "./runtime/runtime.js";
import {
  isModuleBackend,
  type WorkspaceModuleBackend,
  type WorkspaceModuleBackendHandle,
  type WorkspaceRegisteredBackend,
  type WorkspaceRuntimeEvent,
} from "./runtime/types.js";
import { CommandExecutor } from "./shell.js";
import { WorkspaceStub } from "./stub.js";
import { isWorkspaceTransportFailure, WorkspaceTransportError } from "./transport-failure.js";

export interface SyncRetryIntent {
  backend: string;
  attempt: number;
  notBefore: number;
}

/**
 * Durable storage boundary for pending post-command pulls.
 *
 * The host owns persistence and wake-up because the workspace library
 * cannot own a Durable Object alarm. Each backend has at most one intent.
 */
export interface SyncRetryScheduler {
  get(backend: string): Promise<SyncRetryIntent | undefined>;
  schedule(intent: SyncRetryIntent): Promise<void>;
  clear(backend: string): Promise<void>;
}

export interface SyncRetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export type WorkspaceRetryPendingSyncResult =
  | { status: "idle"; backend: string }
  | { status: "complete"; backend: string; applied: number; skipped: ApplyResult["skipped"] }
  | { status: "pending"; backend: string; attempt: number; notBefore: number; error: string }
  | { status: "exhausted"; backend: string; attempt: number; error: string };

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

export interface WorkspaceOptions {
  // Local store backing this Workspace. In a Durable Object, pass
  // `ctx.storage`; in tests, pass a SQLiteTestStorage from
  // @cloudflare/dofs/testing. The constructor opens a
  // Database against it and runs initializeSchema (idempotent).
  storage: DurableObjectStorageLike;

  // Registered execution backends. The first is the default;
  // callers can select another by stable id.
  // Omit to construct a filesystem-only Workspace whose runtime
  // reports that no execution backend is configured.
  backends?: WorkspaceRegisteredBackend[];

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
  // command runtime spans per exec, and `workspace.fs.<op>` per
  // filesystem call routed through the stub. The default is a
  // no-op so the package has no observability cost when callers
  // do not opt in. See `./observe.ts` for the contract and the
  // adapter subpaths for the Cloudflare runtime and OpenTelemetry.
  observer?: WorkspaceObserver;

  // Optional durable retry boundary for failed post-command pulls.
  // The host persists one intent per backend and wakes the Durable
  // Object at intent.notBefore to call retryPendingSync(backend).
  retryScheduler?: SyncRetryScheduler;
  retry?: SyncRetryOptions;

  // Optional git client factory. Omit it to keep the default
  // Workspace graph free of isomorphic-git; pass createGitClient()
  // from @cloudflare/computer/git when the caller needs
  // workspace.git or the worker backend's built-in git command.
  git?: WorkspaceGitFactory;

  // Default identity used by commit-producing git subcommands
  // when neither the call site nor the relevant `GIT_AUTHOR_*` /
  // `GIT_COMMITTER_*` env vars supply one. Threaded through to
  // the configured git factory on first access to `workspace.git`.
  defaultGitIdentity?: GitIdentity;

  // Optional assets publisher used by WorkspaceStub and the worker
  // backend's `assets publish` shell command. Pass an AssetsClient
  // directly, or a factory when the publisher needs the Workspace
  // instance itself (for example, createAssets({ ws, ... })).
  assets?: AssetsClient | ((ws: Workspace) => AssetsClient);

  // Optional Cloudflare Artifacts binding. When configured,
  // `workspace.artifacts` is a session-scoped Artifacts client.
  // The session id defaults to WorkspaceOptions.sessionId; pass
  // `artifacts.sessionId` to override it. When omitted, accessing
  // the client is still possible but every operation fails with a
  // clear configuration error.
  artifacts?: {
    binding: Artifacts;
    sessionId?: string;
  };

  // Add Think's string-oriented WorkspaceLike filesystem methods
  // directly to the Workspace instance. This is off by default so
  // the primary Workspace API stays on the `workspace.fs` facade;
  // enable it when assigning a Workspace to `Think.workspace`.
  useThink?: boolean;
}

export interface ThinkFileInfo {
  path: string;
  name: string;
  type: "file" | "directory";
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThinkWorkspaceCompatibility {
  readFile(path: string): Promise<string | null>;
  readFileBytes(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string): Promise<void>;
  readDir(dir: string, opts?: { limit?: number; offset?: number }): Promise<ThinkFileInfo[]>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  glob(pattern: string): Promise<ThinkFileInfo[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<ThinkFileInfo | null>;
}

export type ThinkWorkspaceFilesystem = Pick<
  WorkspaceFilesystem,
  "find" | "mkdir" | "readFile" | "readdir" | "rm" | "stat" | "writeFile"
>;

export type WorkspaceGitFactory = GitClientFactory;

const GIT_NOT_CONFIGURED_MESSAGE =
  "Workspace git is not configured. Import createGitClient from " +
  "@cloudflare/computer/git and pass createGitClient() as WorkspaceOptions.git.";

const DISABLED_GIT_CLIENT = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "then") return undefined;
      return () => Promise.reject(new Error(GIT_NOT_CONFIGURED_MESSAGE));
    },
  },
) as GitClient;

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
  readonly #moduleBackendsById: Map<string, WorkspaceModuleBackend>;
  readonly #registeredBackendIds: Set<string>;
  readonly #callableBackendIds: Set<string>;
  readonly #defaultBackendId: string | undefined;
  readonly #observer: WorkspaceObserver;
  readonly #now: () => number;
  readonly #retryScheduler: SyncRetryScheduler | undefined;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #retryMaxAttempts: number;
  readonly #sessionId: string;
  readonly #gitFactory: WorkspaceGitFactory | undefined;
  readonly #defaultGitIdentity: GitIdentity | undefined;
  readonly #useThink: boolean;
  readonly #assets: AssetsClient | undefined;
  readonly #artifacts: ArtifactClient;
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
  // A transport-failed handle must finish closing before connect()
  // runs again. This prevents a concurrent caller from reaching a
  // backend's own cache while it still points at the stale handle.
  readonly #disconnecting = new Map<string, Promise<void>>();
  // Per-backend CommandExecutor facades. Constructed alongside each
  // handle; reused for the life of the handle.
  readonly #shells = new Map<string, CommandExecutor>();
  // Cached command adapters presenting a CommandExecutor as the
  // unified backend handle. Cleared alongside #shells so an adapter
  // never outlives the shell it wraps.
  readonly #commandHandles = new Map<string, WorkspaceModuleBackendHandle>();
  readonly #moduleHandles = new Map<string, WorkspaceModuleBackendHandle>();
  readonly #connectingModuleHandles = new Map<string, Promise<WorkspaceModuleBackendHandle>>();
  #connectionGeneration = 0;
  #runtime: WorkspaceRuntime | undefined;
  #readyPromise: Promise<void> | undefined;
  // Per-backend FIFOs that serialize mutating entry points (push,
  // pull, and the shell exec bracket which goes through them) for
  // that backend. A push to backend A does not block exec on
  // backend B. Reads bypass the queue entirely — they hit the
  // local store directly through Workspace.fs. Each value is a
  // single tail-promise; each caller chains its work onto the tail
  // and updates it. See docs/02 "Concurrent mutators".
  readonly #mutationTails = new Map<string, Promise<unknown>>();

  declare readonly readFile?: ThinkWorkspaceCompatibility["readFile"];
  declare readonly readFileBytes?: ThinkWorkspaceCompatibility["readFileBytes"];
  declare readonly writeFile?: ThinkWorkspaceCompatibility["writeFile"];
  declare readonly readDir?: ThinkWorkspaceCompatibility["readDir"];
  declare readonly rm?: ThinkWorkspaceCompatibility["rm"];
  declare readonly glob?: ThinkWorkspaceCompatibility["glob"];
  declare readonly mkdir?: ThinkWorkspaceCompatibility["mkdir"];
  declare readonly stat?: ThinkWorkspaceCompatibility["stat"];

  constructor(options: WorkspaceOptions) {
    this.#now = options.now ?? Date.now;
    this.#retryScheduler = options.retryScheduler;
    this.#retryInitialDelayMs = positiveRetryOption(
      options.retry?.initialDelayMs,
      DEFAULT_RETRY_INITIAL_DELAY_MS,
      "initialDelayMs",
    );
    this.#retryMaxDelayMs = positiveRetryOption(
      options.retry?.maxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      "maxDelayMs",
    );
    this.#retryMaxAttempts = positiveRetryOption(
      options.retry?.maxAttempts,
      DEFAULT_RETRY_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.#sessionId = options.sessionId ?? "";
    this.#gitFactory = options.git;
    this.#defaultGitIdentity = options.defaultGitIdentity;
    this.#useThink = options.useThink ?? false;
    this.#artifacts = options.artifacts
      ? createArtifact(
          options.artifacts.binding,
          options.artifacts.sessionId ?? options.sessionId ?? "",
        )
      : createDisabledArtifactsClient();
    this.#db = new Database(options.storage);
    initializeSchema(this.#db, this.#now);
    this.#fs = new WorkspaceFilesystem(this.#db, { now: this.#now });
    const registered = (options.backends ?? []).slice();
    this.#backends = registered.filter(
      (backend): backend is WorkspaceBackend => !isModuleBackend(backend),
    );
    this.#backendsById = new Map(this.#backends.map((backend) => [backend.id, backend]));
    this.#moduleBackendsById = new Map(
      registered.filter(isModuleBackend).map((backend) => [backend.id, backend]),
    );
    this.#registeredBackendIds = new Set();
    this.#callableBackendIds = new Set(
      registered.filter((backend) => backend.callable === true).map((backend) => backend.id),
    );
    for (const backend of registered) {
      if (this.#registeredBackendIds.has(backend.id)) {
        throw new Error(
          `Workspace: duplicate backend id ${JSON.stringify(backend.id)}. ` +
            "Pass an explicit `id` on each backend's constructor options to " +
            "distinguish them.",
        );
      }
      this.#registeredBackendIds.add(backend.id);
    }
    this.#defaultBackendId = registered[0]?.id;
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
    if (this.#useThink) {
      const think = createThinkCompatibility(this.fs);
      Object.assign(this, think);
    }
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

  get useThink(): boolean {
    return this.#useThink;
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

  // Git facade. Opt-in so the default Workspace graph does not
  // carry isomorphic-git. When configured, it does not require a
  // backend — every supported subcommand reads and writes through
  // the local SQLite-backed VFS. The configured factory decides
  // how the heavy git implementation is loaded.
  //
  // Memoised on a private field so repeated callers share the
  // pack/index cache and resolved modules from the configured
  // implementation.
  get git(): GitClient {
    if (!this.#gitFactory) {
      throw new Error(GIT_NOT_CONFIGURED_MESSAGE);
    }
    if (!this.#git) {
      this.#git = this.#gitFactory({
        ws: this,
        defaultIdentity: this.#defaultGitIdentity,
      });
    }
    return this.#git;
  }

  get artifacts(): ArtifactClient {
    return this.#artifacts;
  }

  get runtime(): WorkspaceRuntime {
    if (!this.#runtime) {
      this.#runtime = new WorkspaceRuntime({
        callableBackendIds: this.#callableBackendIds,
        backendHandle: (id) => this.#backendHandleFor(id),
        resolveBackendId: (id) => this.#resolveBackendId(id) ?? "",
      });
    }
    return this.#runtime;
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
      const id = this.#resolveBackendId(options);
      return (async () => {
        await indexPromise;
        if (!id) return;
        if (this.#moduleBackendsById.has(id)) await this.#moduleHandleFor(id);
        else await this.#handleFor(id);
      })();
    }
    if (options.all) {
      return (async () => {
        await indexPromise;
        await Promise.all([
          ...this.#backends.map((backend) => this.#handleFor(backend.id)),
          ...[...this.#moduleBackendsById.keys()].map((id) => this.#moduleHandleFor(id)),
        ]);
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
  // package doesn't run a background loop. CommandExecutor.exec
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
          if (resolvedId === undefined || this.#moduleBackendsById.has(resolvedId)) return 0;
          return this.#runWithReconnect(resolvedId, "push", async (handle) => {
            // A backend that reuses the host store as its sole
            // source of truth has nothing to ship and no remote to
            // ship to. Short-circuit so the shell exec bracket can
            // keep calling push() unconditionally without paying
            // for it.
            if (handle.sync === "none") return 0;
            return pushOnce(this.#db, handle.rpc.sync, resolvedId);
          });
        },
        (span, outcome) => {
          if (outcome.ok) span.setAttribute("workspace.sync.pushed", outcome.value);
        },
      ),
    );
  }

  pull(id?: string): Promise<ApplyResult> {
    return this.#serialize(id, (resolvedId) => this.#pullResolved(resolvedId));
  }

  /**
   * Run a host-scheduled pending pull from its persisted cursor.
   *
   * The call shares the backend's mutation FIFO with push, pull, and
   * command brackets. A successful pull clears the host's durable
   * intent. A failed pull advances bounded exponential backoff; the
   * last failed attempt remains stored and is reported as exhausted.
   */
  retryPendingSync(id?: string): Promise<WorkspaceRetryPendingSyncResult> {
    return this.#serialize(id, async (resolvedId) => {
      if (resolvedId === undefined) {
        throw new Error("Workspace has no backend configured for pending sync retry");
      }
      const scheduler = this.#retryScheduler;
      if (scheduler === undefined) {
        throw new Error("Workspace has no retryScheduler configured");
      }
      const intent = await scheduler.get(resolvedId);
      if (intent === undefined) return { status: "idle", backend: resolvedId };
      if (intent.attempt > this.#retryMaxAttempts) {
        return {
          status: "exhausted",
          backend: resolvedId,
          attempt: intent.attempt,
          error: "pending sync retry attempts exhausted",
        };
      }
      try {
        const result = await this.#pullResolved(resolvedId);
        await scheduler.clear(resolvedId);
        return {
          status: "complete",
          backend: resolvedId,
          applied: result.applied,
          skipped: result.skipped,
        };
      } catch (error) {
        const message = safeErrorMessage(error);
        if (intent.attempt >= this.#retryMaxAttempts) {
          return {
            status: "exhausted",
            backend: resolvedId,
            attempt: intent.attempt,
            error: message,
          };
        }
        const next = this.#retryIntent(resolvedId, intent.attempt + 1);
        await scheduler.schedule(next);
        return { status: "pending", ...next, error: message };
      }
    });
  }

  #pullResolved(resolvedId: string | undefined): Promise<ApplyResult> {
    return withSpan(
      this.#observer,
      "workspace.sync.pull",
      { "workspace.sync.backend": resolvedId },
      async () => {
        if (resolvedId === undefined || this.#moduleBackendsById.has(resolvedId)) {
          return { applied: 0, skipped: [] };
        }
        return this.#runWithReconnect(resolvedId, "pull", async (handle) => {
          if (handle.sync === "none") return { applied: 0, skipped: [] };
          return pullOnce(this.#db, handle.rpc.sync, resolvedId);
        });
      },
      (span, outcome) => {
        if (!outcome.ok) return;
        span.setAttribute("workspace.sync.applied", outcome.value.applied);
        span.setAttribute("workspace.sync.skipped", outcome.value.skipped.length);
      },
    );
  }

  async #schedulePendingSync(id: string): Promise<void> {
    const scheduler = this.#retryScheduler;
    if (scheduler === undefined) return;
    await this.#serialize(id, async (resolvedId) => {
      if (resolvedId === undefined || (await scheduler.get(resolvedId)) !== undefined) return;
      await scheduler.schedule(this.#retryIntent(resolvedId, 1));
    });
  }

  #retryIntent(backend: string, attempt: number): SyncRetryIntent {
    const delay = Math.min(
      this.#retryMaxDelayMs,
      this.#retryInitialDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    return { backend, attempt, notBefore: this.#now() + delay };
  }

  // Drop and close a cached handle after a transport failure.
  // Matches by identity so a late error from an old operation cannot
  // tear down a replacement that another caller already installed.
  // Cache deletion is synchronous; close() is awaited before retrying
  // so backends with their own handle cache cannot return the same
  // broken session from connect().
  async #invalidateHandle(id: string, handle: BackendHandle): Promise<boolean> {
    if (this.#handles.get(id) !== handle) return false;
    this.#handles.delete(id);
    this.#shells.delete(id);
    this.#commandHandles.delete(id);
    const closing = handle.close().catch(() => undefined);
    this.#disconnecting.set(id, closing);
    try {
      await closing;
    } finally {
      if (this.#disconnecting.get(id) === closing) this.#disconnecting.delete(id);
    }
    return true;
  }

  // Run an idempotent backend operation with one reconnect retry.
  // Handle acquisition is inside the loop so a readiness failure and
  // an RPC failure follow the same bounded policy. pushOnce and
  // pullOnce are safe replay boundaries: their durable watermarks
  // advance only after committed work and their apply paths absorb
  // duplicates.
  async #runWithReconnect<T>(
    id: string,
    operation: string,
    op: (handle: BackendHandle) => Promise<T>,
  ): Promise<T> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: BackendHandle | undefined;
      try {
        handle = await this.#handleFor(id);
        return await op(handle);
      } catch (error) {
        if (!isWorkspaceTransportFailure(error)) throw error;
        if (handle !== undefined) await this.#invalidateHandle(id, handle);
        if (attempt === 0) {
          firstError = error;
          continue;
        }
        const initial = safeErrorMessage(firstError).slice(0, 160);
        const terminal = safeErrorMessage(error).slice(0, 240);
        throw new WorkspaceTransportError(
          `Workspace backend ${JSON.stringify(id)}: ${operation} failed after 1 reconnect retry: initial=${initial}; last=${terminal}`,
          { cause: error },
        );
      }
    }
    throw new Error("unreachable reconnect state");
  }

  // Per-backend mutation FIFO. Public push() / pull() calls and each
  // command's pre-exec push and post-stream pull route through this;
  // the FIFO is not held for the command's lifetime. Reads bypass it
  // entirely. A push to backend A does not block sync on backend B
  // because each id gets its own tail-promise. The undefined id (filesystem-only
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
    if (this.#registeredBackendIds.size === 0) return undefined;
    const target = id ?? this.#defaultBackendId;
    if (target === undefined) return undefined;
    if (!this.#registeredBackendIds.has(target)) {
      throw new Error(
        `Workspace: no backend with id ${JSON.stringify(target)}. ` +
          `Configured backends: ${[...this.#registeredBackendIds].map((key) => JSON.stringify(key)).join(", ") || "<none>"}.`,
      );
    }
    return target;
  }

  async close(): Promise<void> {
    // Close every cached handle in parallel. Drop caches before
    // awaiting so a subsequent ready() / exec sees an empty slate
    // and rebuilds against fresh handles.
    this.#connectionGeneration += 1;
    const handles = [...this.#handles.values()];
    const moduleHandles = [...this.#moduleHandles.values()];
    this.#handles.clear();
    this.#shells.clear();
    this.#commandHandles.clear();
    this.#connecting.clear();
    const disconnecting = [...this.#disconnecting.values()];
    this.#moduleHandles.clear();
    this.#connectingModuleHandles.clear();
    this.#readyPromise = undefined;
    await Promise.all([
      ...disconnecting,
      ...[...handles, ...moduleHandles].map(async (h) => {
        try {
          await h.close?.();
        } catch {
          // close() is best-effort; a transport that's already
          // gone shouldn't take the workspace down with it.
        }
      }),
    ]);
  }

  // Unified backend handle used by the runtime. Module backends
  // return their native handle; command backends are presented
  // through the same interface by an adapter over their
  // CommandExecutor, so the runtime has a single execution path.
  async #backendHandleFor(id: string): Promise<WorkspaceModuleBackendHandle> {
    if (this.#moduleBackendsById.has(id)) return this.#moduleHandleFor(id);
    return this.#commandHandleFor(id);
  }

  // Command adapters are cached per backend so the module and
  // command paths are symmetric. The cache is cleared alongside
  // #shells whenever a handle is invalidated, so an adapter never
  // outlives the shell it closed over.
  async #commandHandleFor(id: string): Promise<WorkspaceModuleBackendHandle> {
    const cached = this.#commandHandles.get(id);
    if (cached) return cached;
    const { shell, handle } = await this.#shellFor(id);
    const onError = (error: unknown) => this.#onShellError(id, handle, error);
    const adapter: WorkspaceModuleBackendHandle = {
      exec: async (input) => {
        let envelope: Awaited<ReturnType<CommandExecutor["exec"]>>;
        try {
          envelope = await shell.exec(input.source, {
            id: input.id,
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            env: input.env,
            stdin: input.stdin,
          });
        } catch (error) {
          onError(error);
          throw error;
        }
        return {
          id: envelope.id,
          events: watchStreamForTransportError(
            envelope.events,
            onError,
          ) as ReadableStream<WorkspaceRuntimeEvent>,
          sync: envelope.sync,
        };
      },
      getExec: async ({ id: execId, after }) => {
        const resume = after === undefined ? "full" : after;
        let envelope: Awaited<ReturnType<CommandExecutor["get"]>>;
        try {
          envelope = await shell.get(execId, { resume });
        } catch (error) {
          onError(error);
          throw error;
        }
        return {
          id: envelope.id,
          events: watchStreamForTransportError(
            envelope.events,
            onError,
          ) as ReadableStream<WorkspaceRuntimeEvent>,
          sync: envelope.sync,
        };
      },
      killExec: async ({ id: execId, signal }) => {
        try {
          await shell.kill(execId, signal);
        } catch (error) {
          onError(error);
          throw error;
        }
      },
      disposeExec: async ({ id: execId }) => {
        try {
          await shell.dispose(execId);
        } catch (error) {
          onError(error);
          throw error;
        }
      },
    };
    this.#commandHandles.set(id, adapter);
    return adapter;
  }

  #moduleHandleFor(id: string): Promise<WorkspaceModuleBackendHandle> {
    const cached = this.#moduleHandles.get(id);
    if (cached) return Promise.resolve(cached);
    const inflight = this.#connectingModuleHandles.get(id);
    if (inflight) return inflight;
    const backend = this.#moduleBackendsById.get(id);
    if (!backend) {
      return Promise.reject(
        new Error(`Workspace backend ${JSON.stringify(id)} does not execute modules.`),
      );
    }
    const generation = this.#connectionGeneration;
    let promise!: Promise<WorkspaceModuleBackendHandle>;
    promise = withSpan(
      this.#observer,
      "workspace.connect",
      { "workspace.backend.id": id, "workspace.backend.type": backend.type },
      () =>
        backend.connect({
          db: this.#db,
          fs: this.#fs,
          git: this.#gitFactory ? this.git : DISABLED_GIT_CLIENT,
          artifacts: this.#artifacts,
        }),
    )
      .then(async (handle) => {
        if (generation !== this.#connectionGeneration) {
          await handle.close?.().catch(() => undefined);
          throw new Error(`Workspace closed while backend ${JSON.stringify(id)} was connecting.`);
        }
        this.#moduleHandles.set(id, handle);
        return handle;
      })
      .finally(() => {
        if (this.#connectingModuleHandles.get(id) === promise) {
          this.#connectingModuleHandles.delete(id);
        }
      });
    this.#connectingModuleHandles.set(id, promise);
    return promise;
  }

  // Lazy backend connect. Concurrent callers for the same id
  // share one in-flight promise. The resolved handle is cached
  // until close() or the backend's `closed` promise fires.
  #handleFor(id: string): Promise<BackendHandle> {
    const cached = this.#handles.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const disconnecting = this.#disconnecting.get(id);
    if (disconnecting !== undefined) {
      return disconnecting.then(() => this.#handleFor(id));
    }
    const inflight = this.#connecting.get(id);
    if (inflight !== undefined) return inflight;
    const backend = this.#backendsById.get(id);
    if (backend === undefined) {
      return Promise.reject(new Error(`Workspace: no backend with id ${JSON.stringify(id)}`));
    }
    const generation = this.#connectionGeneration;
    let promise!: Promise<BackendHandle>;
    promise = (async () => {
      let handle: BackendHandle | undefined;
      try {
        handle = await withSpan(
          this.#observer,
          "workspace.connect",
          { "workspace.backend.id": id, "workspace.backend.type": backend.type },
          () =>
            backend.connect({
              db: this.#db,
              fs: this.#fs,
              git: this.#gitFactory ? this.git : DISABLED_GIT_CLIENT,
              artifacts: this.#artifacts,
            }),
        );
        if (generation !== this.#connectionGeneration) {
          throw new Error(`Workspace closed while backend ${JSON.stringify(id)} was connecting.`);
        }
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
        if (generation !== this.#connectionGeneration) {
          throw new Error(`Workspace closed while backend ${JSON.stringify(id)} was connecting.`);
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
                this.#commandHandles.delete(id);
              }
            });
        }
        return handle;
      } catch (error) {
        // A handle that fails setup was never published, but the
        // backend may still cache it internally. Close it so the next
        // connect attempt cannot return the same broken session.
        if (handle !== undefined && this.#handles.get(id) !== handle) {
          await handle.close().catch(() => undefined);
        }
        throw error;
      }
    })().finally(() => {
      // Always drop this in-flight entry so a failed connect can be
      // retried, without deleting a newer connection started after close().
      if (this.#connecting.get(id) === promise) this.#connecting.delete(id);
    });
    this.#connecting.set(id, promise);
    return promise;
  }

  // Per-backend CommandExecutor, constructed on demand and cached
  // for the life of the handle. Returns both the shell and the
  // BackendHandle it was built against so the caller can hold the
  // handle reference for a later identity check; #invalidateHandle
  // clears both caches together, so a shell pulled from #shells is
  // always paired with the live handle for that id at the moment
  // of the lookup.
  async #shellFor(id: string): Promise<{ shell: CommandExecutor; handle: BackendHandle }> {
    const handle = await this.#handleFor(id);
    const cached = this.#shells.get(id);
    if (cached !== undefined) return { shell: cached, handle };
    const shell = new CommandExecutor(
      handle.rpc.shell,
      {
        push: () => this.push(id),
        pull: () => this.pull(id),
        onPullPending: () => this.#schedulePendingSync(id),
      },
      this.#observer,
    );
    this.#shells.set(id, shell);
    return { shell, handle };
  }

  // Invalidate the cached handle for `id` when a shell-routed RPC
  // fails with a known transport error. Compares the caller's
  // captured handle against the live cache entry so a late-failing
  // operation against an old handle can't clobber a newer one that
  // a concurrent reconnect already installed.
  #onShellError(id: string, handle: BackendHandle, error: unknown): void {
    if (!isWorkspaceTransportFailure(error)) return;
    void this.#invalidateHandle(id, handle);
  }
}

// Pass an execution event stream through unchanged, but classify any
// error that tears it down. A transport-classified mid-stream failure
// invalidates the cached backend handle so the next call reconnects,
// matching the invalidation the shell router used to install around a
// command handle's result().
function watchStreamForTransportError<T>(
  events: ReadableStream<T>,
  onError: (error: unknown) => void,
): ReadableStream<T> {
  const reader = events.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        onError(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function positiveRetryOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`Workspace retry.${name} must be a positive integer`);
  }
  return resolved;
}

function createDisabledArtifactsClient(): ArtifactClient {
  const fail = () => {
    throw new ArtifactError("ENOCONFIG", "Workspace Artifacts binding is not configured");
  };
  return {
    sessionId: "",
    create: fail,
    get: fail,
    list: fail,
    import: fail,
    delete: fail,
    createToken: fail,
    listTokens: fail,
    getToken: fail,
    revokeToken: fail,
    async cli(input) {
      return runArtifactsCLI(this, input);
    },
  } as ArtifactClient;
}

export function createThinkCompatibility(
  fs: ThinkWorkspaceFilesystem,
): ThinkWorkspaceCompatibility {
  return {
    async readFile(path) {
      try {
        return await fs.readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readFileBytes(path) {
      try {
        return await drainBytes(await fs.readFile(path));
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path, content) {
      await fs.writeFile(path, content);
    },
    async readDir(dir, opts) {
      const entries = await fs.readdir(dir);
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? entries.length;
      return entries.slice(offset, offset + limit).map((entry) =>
        toThinkFileInfo({
          path: joinPath(dir, entry.name),
          name: entry.name,
          size: 0,
          mtime: 0,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
        }),
      );
    },
    async rm(path, opts) {
      await fs.rm(path, opts);
    },
    async glob(pattern) {
      const { directory, relativePattern } = splitGlobPattern(pattern);
      const matches = await fs.find(directory, relativePattern);
      return matches.map((match) =>
        toThinkFileInfo({
          path: match.path,
          name: basename(match.path),
          size: 0,
          mtime: 0,
          isDirectory: match.type === "dir",
          isFile: match.type === "file",
        }),
      );
    },
    async mkdir(path, opts) {
      await fs.mkdir(path, opts);
    },
    async stat(path) {
      try {
        const stat = await fs.stat(path);
        return toThinkFileInfo({ ...stat, path, name: basename(path) });
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
  };
}

async function drainBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function toThinkFileInfo(input: {
  path: string;
  name: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
  isFile: boolean;
}): ThinkFileInfo {
  const type = input.isDirectory ? "directory" : "file";
  return {
    path: input.path,
    name: input.name,
    type,
    mimeType: type === "directory" ? "inode/directory" : "application/octet-stream",
    size: input.size,
    createdAt: input.mtime,
    updatedAt: input.mtime,
  };
}

function splitGlobPattern(pattern: string): { directory: string; relativePattern?: string } {
  const normalized = pattern.startsWith("/") ? pattern : `/workspace/${pattern}`;
  const wildcard = firstWildcardIndex(normalized);
  if (wildcard === -1) {
    return { directory: dirname(normalized), relativePattern: basename(normalized) };
  }
  const slash = normalized.lastIndexOf("/", wildcard);
  const directory = slash <= 0 ? "/" : normalized.slice(0, slash);
  const relativePattern = normalized.slice(slash + 1);
  return { directory, relativePattern };
}

function firstWildcardIndex(pattern: string): number {
  const star = pattern.indexOf("*");
  const question = pattern.indexOf("?");
  if (star === -1) return question;
  if (question === -1) return star;
  return Math.min(star, question);
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}
