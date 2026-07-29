// WorkspaceStub — wraps a host-side Workspace as an RpcTarget so it
// can be handed across the Workers RPC boundary.
//
// Construct it via `workspace.stub()` — the Workspace class owns
// the lifecycle and the WorkspaceStub just delegates.
//
// Usage shape:
//
//   // Inside a DO that owns the live computerd connection:
//   class ComputerdContainer extends DurableObject {
//     #workspace = new Workspace({ backends: [...] });
//     async getWorkspace(): Promise<WorkspaceStub> {
//       await this.#workspace.ready();
//       return this.#workspace.stub();
//     }
//   }
//
//   // From a Worker (or another DO):
//   const ws = await env.COMPUTERD.get(id).getWorkspace();
//   await ws.fs.writeFile("/foo", bytes);
//   const handle = await ws.shell.exec("ls /workspace");
//   const { exitCode, stdout, stderr } = await handle.result();
//
// All the SyncRPC streaming (push / pushObjects / fetchObjects /
// fetchChanges) happens on the capnweb wire inside the DO. What
// crosses the Workers-RPC boundary here is only the high-level
// value-shaped facade — writeFile / readFile / stat / exec —
// because Workers RPC doesn't carry non-byte ReadableStreams or
// capnweb stubs.
//
// Streaming exec crosses the boundary as bytes. Workers RPC only
// carries ReadableStream<Uint8Array>, so the exec handle's event
// stream is framed as JSONL bytes by handle.stream() and inflated
// back into events on the Worker side (see exec-wire.ts and the
// getWorkspace client). The handle also exposes result() (run-and-
// wait) and kill().
//
// RpcTarget comes from capnweb rather than `cloudflare:workers`.
// Per capnweb's docs, that import is an alias for the workerd
// builtin when running under workerd, so the runtime behaviour is
// identical; the difference is that capnweb's export resolves
// under both workerd and node (tests, type-only consumers), while
// `cloudflare:workers` only resolves under workerd.

import { trackStub, untrackStub } from "@cloudflare/computer-rpc/debug";
import type {
  GrepOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
  WriteFileContent,
  WriteFileOptions,
} from "@cloudflare/dofs";
import { RpcTarget } from "capnweb";

import type {
  ArtifactClient,
  ArtifactImportOptions,
  ArtifactImportSource,
  ArtifactRepoSummary,
  ArtifactScope,
  ArtifactsCLIInput,
  ArtifactsCLIResult,
} from "./artifacts/index.js";
import type { ShareOptions } from "./assets/index.js";
import { encodeExecEvent } from "./exec-wire.js";
import type { GitCliInput, GitCliResult } from "./git/index.js";
import { withSpan } from "./observe.js";
import { assertNotTemplate } from "./sh.js";
import type { ExecEncoding, ExecHandle, ExecSyncResult, WorkspaceExecEvent } from "./shell.js";
import type { Workspace } from "./workspace.js";

export interface WorkspaceExecOptions {
  cwd?: string;
  // "utf8" decodes stdout/stderr chunks through a streaming
  // TextDecoder so multi-byte boundaries survive. Default leaves
  // bytes as Uint8Array.
  encoding?: "utf8";
  // Backend selector. Omit to use the default backend (the first
  // one configured on the Workspace); pass the id of another
  // configured backend to route this call there.
  backend?: string;
}

export interface WorkspaceExecResult<E extends "utf8" | undefined = undefined> {
  exitCode: number;
  stdout: E extends "utf8" ? string : Uint8Array;
  stderr: E extends "utf8" ? string : Uint8Array;
  sync: ExecSyncResult;
}

// Filesystem half. A direct proxy onto Workspace.fs — every
// public WorkspaceFilesystem method is mirrored verbatim so the
// remote surface matches the in-process surface one-for-one.
//
// All argument and return types are already JSRPC-compatible:
// strings, plain objects, Uint8Array, and a single byte-shaped
// ReadableStream<Uint8Array> on readFile. writeFile's
// WriteFileContent union includes ReadableStream<Uint8Array> for
// the same reason.
export class WorkspaceFilesystemStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  // --- Reads -------------------------------------------------------

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    return withSpan(this.#ws.observer, "workspace.fs.readFile", { "workspace.fs.path": path }, () =>
      this.#ws.fs.readFile(path, optionsOrEncoding as ReadFileOptions),
    );
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return withSpan(this.#ws.observer, "workspace.fs.stat", { "workspace.fs.path": path }, () =>
      this.#ws.fs.stat(path),
    );
  }

  lstat(path: string): Promise<WorkspaceStatResult> {
    return withSpan(this.#ws.observer, "workspace.fs.lstat", { "workspace.fs.path": path }, () =>
      this.#ws.fs.lstat(path),
    );
  }

  readlink(path: string): Promise<string> {
    return withSpan(this.#ws.observer, "workspace.fs.readlink", { "workspace.fs.path": path }, () =>
      this.#ws.fs.readlink(path),
    );
  }

  readdir(path: string): Promise<WorkspaceDirentResult[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.readdir",
      { "workspace.fs.path": path },
      () => this.#ws.fs.readdir(path),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.fs.entries", outcome.value.length);
      },
    );
  }

  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.find",
      { "workspace.fs.path": directory, "workspace.fs.pattern": pattern },
      () => this.#ws.fs.find(directory, pattern),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.fs.matches", outcome.value.length);
      },
    );
  }

  ls(prefix: string): Promise<string[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.ls",
      { "workspace.fs.path": prefix },
      () => this.#ws.fs.ls(prefix),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.fs.entries", outcome.value.length);
      },
    );
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.grep",
      { "workspace.fs.path": path, "workspace.fs.pattern": pattern },
      () => this.#ws.fs.grep(pattern, path, options),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.fs.matches", outcome.value.length);
      },
    );
  }

  // --- Mutations ---------------------------------------------------

  writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.writeFile",
      { "workspace.fs.path": path },
      () => this.#ws.fs.writeFile(path, content, options),
    );
  }

  mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.mkdir",
      { "workspace.fs.path": path, "workspace.fs.recursive": options.recursive },
      () => this.#ws.fs.mkdir(path, options),
    );
  }

  rm(path: string, options: RmOptions = {}): Promise<void> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.rm",
      {
        "workspace.fs.path": path,
        "workspace.fs.recursive": options.recursive,
        "workspace.fs.force": options.force,
      },
      () => this.#ws.fs.rm(path, options),
    );
  }

  chmod(path: string, mode: number): Promise<void> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.chmod",
      { "workspace.fs.path": path, "workspace.fs.mode": mode },
      () => this.#ws.fs.chmod(path, mode),
    );
  }

  symlink(target: string, path: string): Promise<void> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.symlink",
      { "workspace.fs.path": path, "workspace.fs.target": target },
      () => this.#ws.fs.symlink(target, path),
    );
  }
}

// How the handle was consumed, fed back to the exec span so it can
// record the exit code. result() carries the full outcome; stream()
// carries the exit code observed on the wire and zeroes the sync
// counts (raw stream consumption skips the post-exit pull, matching
// the host ExecHandle contract).
interface ConsumeOutcome {
  exitCode: number;
  pushed: number;
  pulled: number;
  skippedCount: number;
  sync: ExecSyncResult;
}

// A deferred the exec span awaits. Resolving it (via result(),
// stream(), or dispose) lets the span close and record its outcome.
interface Consumer {
  promise: Promise<ConsumeOutcome>;
  resolve(outcome: ConsumeOutcome): void;
}

function makeConsumer(): Consumer {
  let resolve!: (outcome: ConsumeOutcome) => void;
  const promise = new Promise<ConsumeOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function emptyConsumeOutcome(exitCode = -1): ConsumeOutcome {
  return {
    exitCode,
    pushed: 0,
    pulled: 0,
    skippedCount: 0,
    sync: { status: "complete", applied: 0, skipped: [] },
  };
}

// Exec handle returned from WorkspaceShellStub.exec. Holds the
// underlying host ExecHandle and projects it across Workers RPC:
//
//   - result() drains the handle and returns the run-and-wait result.
//   - stream() returns the event stream framed as JSONL bytes — the
//     one shape Workers RPC carries — for run-and-stream callers. The
//     client side inflates it back into events.
//   - kill() forwards a signal to the running command.
//
// result() and stream() are mutually exclusive: each drains the
// single underlying handle, so the first one called wins and the
// other throws (the host ExecHandle is a one-shot ReadableStream).
// This mirrors the host contract exactly.
export class WorkspaceExecHandleStub<E extends "utf8" | undefined = undefined> extends RpcTarget {
  readonly #handle: Promise<ExecHandle<E>>;
  readonly #consumer: Consumer;
  // Resolves when the exec span has closed (finalize has run). result()
  // awaits it so the span's attributes are set before result() returns
  // — observers see a complete span synchronously after the await.
  readonly #span: Promise<unknown>;
  #consumed = false;

  constructor(handle: Promise<ExecHandle<E>>, consumer: Consumer, span: Promise<unknown>) {
    super();
    this.#handle = handle;
    this.#consumer = consumer;
    this.#span = span;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    // If neither result() nor stream() ran, release the exec span so
    // it doesn't hang open, and cancel the handle's stream so computerd
    // stops the command rather than buffering forever.
    if (!this.#consumed) {
      this.#consumed = true;
      this.#consumer.resolve(emptyConsumeOutcome());
      this.#handle
        .then((handle) => handle.cancel?.())
        .catch(() => {
          // best effort — nothing to do if the handle never resolved
        });
    }
    untrackStub(this);
  }

  #claim(): void {
    if (this.#consumed) {
      throw new Error("exec handle already consumed: result() and stream() are single-shot");
    }
    this.#consumed = true;
  }

  async result(): Promise<WorkspaceExecResult<E>> {
    this.#claim();
    try {
      const handle = await this.#handle;
      const result = await handle.result();
      this.#consumer.resolve({
        exitCode: result.exitCode,
        pushed: result.pushed,
        pulled: result.pulled,
        skippedCount: result.skipped.length,
        sync: result.sync,
      });
      // Let the span close before returning so its attributes are set.
      await this.#span.catch(() => {});
      return {
        exitCode: result.exitCode,
        // joinParts in shell.ts returns string for "utf8",
        // Uint8Array otherwise — exactly the
        // WorkspaceExecResult shape.
        stdout: result.stdout as WorkspaceExecResult<E>["stdout"],
        stderr: result.stderr as WorkspaceExecResult<E>["stderr"],
        sync: result.sync,
      };
    } catch (error) {
      this.#consumer.resolve(emptyConsumeOutcome());
      throw error;
    }
  }

  // Event stream framed as JSONL bytes for the wire. The client
  // decodes it back into WorkspaceExecEvents. Raw stream consumption
  // skips the post-exit pull, so the exec span records zero sync
  // counts; the exit code is captured off the wire as it passes.
  stream(): ReadableStream<Uint8Array> {
    this.#claim();
    const consumer = this.#consumer;
    let reader: ReadableStreamDefaultReader<WorkspaceExecEvent<E>> | undefined;
    let exitCode = -1;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            if (reader === undefined) {
              const handle = await this.#handle;
              reader = (handle as ReadableStream<WorkspaceExecEvent<E>>).getReader();
            }
            const { value, done } = await reader.read();
            if (done) {
              reader.releaseLock();
              reader = undefined;
              controller.close();
              consumer.resolve(emptyConsumeOutcome(exitCode));
              return;
            }
            if (value.name === "exit") exitCode = value.value;
            controller.enqueue(encodeExecEvent(value as WorkspaceExecEvent<ExecEncoding>));
          } catch (error) {
            consumer.resolve(emptyConsumeOutcome());
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          consumer.resolve(emptyConsumeOutcome());
          await reader?.cancel(reason);
          reader?.releaseLock();
          reader = undefined;
        },
      },
      { highWaterMark: 0 },
    );
  }

  async kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void> {
    const handle = await this.#handle;
    await handle.kill(signal);
  }
}

// Assets half. Pure value returns: `publish(path, { expiresAfter })`
// resolves to the share URL string. The configured assets client
// lives on the durable-object side where the R2 binding and signing
// secrets are available; the worker-backend shell only reaches this
// stub through the `assets publish` custom command.
export class WorkspaceAssetsStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  publish(path: string, options: Pick<ShareOptions, "expiresAfter">): Promise<string> {
    return withSpan(
      this.#ws.observer,
      "workspace.assets.publish",
      { "workspace.fs.path": path, "workspace.assets.expires_after_ms": options.expiresAfter },
      async () => {
        if (this.#ws.assets === undefined) {
          throw new Error("Workspace assets are not configured");
        }
        return this.#ws.assets.share(path, { expiresAfter: options.expiresAfter });
      },
    );
  }
}

export class WorkspaceArtifactsStub extends RpcTarget {
  readonly #artifacts: ArtifactClient;

  constructor(artifacts: ArtifactClient) {
    super();
    this.#artifacts = artifacts;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#artifacts.create(name, opts);
  }

  get(name: string): Promise<ArtifactsRepoInfo> {
    return this.#artifacts.get(name);
  }

  list(): Promise<ArtifactRepoSummary[]> {
    return this.#artifacts.list();
  }

  import(
    name: string,
    source: ArtifactImportSource,
    opts?: ArtifactImportOptions,
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#artifacts.import(name, source, opts);
  }

  delete(name: string): Promise<boolean> {
    return this.#artifacts.delete(name);
  }

  createToken(
    name: string,
    scope?: ArtifactScope,
    ttl?: number,
  ): Promise<ArtifactsCreateTokenResult> {
    return this.#artifacts.createToken(name, scope, ttl);
  }

  listTokens(name: string): Promise<ArtifactsTokenListResult> {
    return this.#artifacts.listTokens(name);
  }

  getToken(name: string, id: string): Promise<ArtifactsTokenInfo> {
    return this.#artifacts.getToken(name, id);
  }

  revokeToken(name: string, tokenOrId: string): Promise<boolean> {
    return this.#artifacts.revokeToken(name, tokenOrId);
  }

  cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> {
    return this.#artifacts.cli(input);
  }
}

// Git half. Pure value returns — every method takes JSRPC-
// friendly inputs (strings, plain objects) and resolves to a
// plain `{ stdout, stderr, exitCode }`. No nested stubs to
// dispose; the parent `WorkspaceStub` cascades disposal into
// this one for symmetry with `fs` / `shell`.
//
// Only `cli` is surfaced across the wire. The typed `clone` /
// `diff` / `log` / etc. methods stay on the durable-object
// side; their inputs (progress callbacks, `onAuth`) don't
// cross Workers RPC cleanly, and the CLI path covers every
// consumer who needs git access through a stub.
export class WorkspaceGitStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  cli(input: GitCliInput): Promise<GitCliResult> {
    return this.#ws.git.cli(input);
  }
}

// Shell half. exec() returns an RpcTarget handle whose only
// method today is result(). Streaming exec lands as a separate
// method when a concrete caller needs it; see the note at the
// top of this file.
export class WorkspaceShellStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  exec(command: string): Promise<WorkspaceExecHandleStub<undefined>>;
  exec(
    command: string,
    options: WorkspaceExecOptions & { encoding: "utf8" },
  ): Promise<WorkspaceExecHandleStub<"utf8">>;
  exec(command: string, options: WorkspaceExecOptions): Promise<WorkspaceExecHandleStub<undefined>>;
  async exec(
    command: string,
    options: WorkspaceExecOptions = {},
  ): Promise<WorkspaceExecHandleStub<"utf8" | undefined>> {
    // A worker that calls this as a tagged template ships a
    // TemplateStringsArray over Workers RPC, which loses its `.raw`
    // property to structured clone before it lands here. Reject it
    // so the unsafe path fails loudly; escaping belongs caller-side
    // through sh`...`.
    assertNotTemplate(command);
    // Heal a torn-down session before reaching for the shell. The
    // backend's `closed` listener (see workspace.ts) clears #handle,
    // #shell, and #readyPromise on a mid-session transport drop, so
    // a bare `this.#ws.shell` would throw "Workspace not connected"
    // until a caller manually called ready() again. ready() is
    // idempotent on a live handle and re-enters connect() on a dead
    // one, so a stale container is detected and replaced
    // transparently here.
    await this.#ws.ready();

    // Kick off the exec eagerly so the caller's first round trip
    // (the one that built this stub) already has the spawn in
    // flight. The handle is consumed later by the returned stub's
    // result() or stream().
    //
    // The bracket runs inside one `workspace.shell.exec` span. The
    // span stays open until the handle is consumed: the spawn runs
    // inside the callback (so `workspace.shell.exec.spawn` and the
    // pre-exec push nest under it), then the callback awaits the
    // consumer deferred, which the stub resolves from result() /
    // stream() / dispose. Because the recorder keeps the span on its
    // stack across that await, the post-drain pull triggered by
    // result() also nests under this span.
    const consumer = makeConsumer();
    let resolveHandle!: (handle: ExecHandle<"utf8" | undefined>) => void;
    let rejectHandle!: (error: unknown) => void;
    const handle = new Promise<ExecHandle<"utf8" | undefined>>((resolve, reject) => {
      resolveHandle = resolve;
      rejectHandle = reject;
    });
    // Swallow rejections on the convenience promise; the real
    // rejection is delivered to whoever awaits the handle.
    handle.catch(() => {});

    const span = withSpan(
      this.#ws.observer,
      "workspace.shell.exec",
      {
        "workspace.shell.cwd": options.cwd,
        "workspace.shell.encoding": options.encoding,
        "workspace.shell.backend": options.backend,
      },
      async () => {
        const spawned =
          options.encoding === "utf8"
            ? await this.#ws.shell.exec(command, {
                cwd: options.cwd,
                encoding: "utf8",
                backend: options.backend,
              })
            : await this.#ws.shell.exec(command, {
                cwd: options.cwd,
                backend: options.backend,
              });
        resolveHandle(spawned as ExecHandle<"utf8" | undefined>);
        return consumer.promise;
      },
      (span, outcome) => {
        if (!outcome.ok) return;
        span.setAttribute("workspace.shell.exit_code", outcome.value.exitCode);
        span.setAttribute("workspace.shell.pushed", outcome.value.pushed);
        span.setAttribute("workspace.shell.pulled", outcome.value.pulled);
        span.setAttribute("workspace.shell.skipped", outcome.value.skippedCount);
        span.setAttribute("workspace.shell.sync.status", outcome.value.sync.status);
        if (outcome.value.sync.status === "pending") {
          span.setAttribute("workspace.shell.sync.error", outcome.value.sync.error);
        }
      },
    );
    // If the spawn throws, the span rejects: forward the failure to
    // the handle so result() / stream() reject, and keep the span
    // promise from surfacing as an unhandled rejection.
    span.catch((error) => rejectHandle(error));
    return new WorkspaceExecHandleStub<"utf8" | undefined>(handle, consumer, span);
  }
}

// Top-level wrapper. Two sub-RpcTargets let callers use promise
// pipelining: `stub.fs.writeFile(...)` is one round trip, not two.
//
// Construct via `workspace.stub()` rather than directly — the
// Workspace owns the lifecycle and the stub just delegates.
//
// Note the name collision: the *type* `WorkspaceRPC` is also
// exported by @cloudflare/computer-rpc as the wire contract
// between computerd and the DO. WorkspaceStub here is a different thing
// (the Workers-RPC value carried between the DO and a Worker), so
// the name doesn't clash.
export class WorkspaceStub extends RpcTarget {
  // Getters rather than instance properties so Workers RPC
  // exposes them through the stub proxy. Plain readonly fields
  // set in the constructor land as private isolate state and the
  // proxy reports "method not implemented".
  readonly #fs: WorkspaceFilesystemStub;
  readonly #shell: WorkspaceShellStub;
  readonly #git: WorkspaceGitStub;
  readonly #assets: WorkspaceAssetsStub | undefined;
  readonly #artifacts: WorkspaceArtifactsStub;

  constructor(ws: Workspace) {
    super();
    this.#fs = new WorkspaceFilesystemStub(ws);
    this.#shell = new WorkspaceShellStub(ws);
    this.#git = new WorkspaceGitStub(ws);
    this.#assets = ws.assets === undefined ? undefined : new WorkspaceAssetsStub(ws);
    this.#artifacts = new WorkspaceArtifactsStub(ws.artifacts);
    trackStub(this);
  }

  // Cascade disposal to the sub-stubs. Workers-RPC exposes them as
  // getters off this object, so the caller can't reach them as
  // independent stubs; their lifetime is bounded by ours. Without
  // this, the per-iteration leak observed in the DO↔Worker stub
  // soak (WorkspaceFilesystemStub +1, WorkspaceShellStub +1 every
  // getWorkspace() call) never collapses.
  [Symbol.dispose](): void {
    this.#fs[Symbol.dispose]();
    this.#shell[Symbol.dispose]();
    this.#git[Symbol.dispose]();
    this.#assets?.[Symbol.dispose]();
    this.#artifacts[Symbol.dispose]();
    untrackStub(this);
  }

  get fs(): WorkspaceFilesystemStub {
    return this.#fs;
  }

  get shell(): WorkspaceShellStub {
    return this.#shell;
  }

  get git(): WorkspaceGitStub {
    return this.#git;
  }

  get assets(): WorkspaceAssetsStub | undefined {
    return this.#assets;
  }

  get artifacts(): WorkspaceArtifactsStub {
    return this.#artifacts;
  }
}
