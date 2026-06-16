// WorkspaceStub — wraps a host-side Workspace as an RpcTarget so it
// can be handed across the Workers RPC boundary.
//
// Construct it via `workspace.stub()` — the Workspace class owns
// the lifecycle and the WorkspaceStub just delegates.
//
// Usage shape:
//
//   // Inside a DO that owns the live wsd connection:
//   class WsdContainer extends DurableObject {
//     #workspace = new Workspace({ backends: [...] });
//     async getWorkspace(): Promise<WorkspaceStub> {
//       await this.#workspace.ready();
//       return this.#workspace.stub();
//     }
//   }
//
//   // From a Worker (or another DO):
//   const ws = await env.WSD.get(id).getWorkspace();
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
// Streaming exec is intentionally absent from this surface for
// now. Workers RPC only carries ReadableStream<Uint8Array>, so a
// streamed exec would have to frame events as bytes (SSE, length-
// prefixed JSON, etc.) — punted until we have a concrete caller
// that needs it. Today exec() returns a handle whose only method
// is result(), matching the run-and-wait half of WorkspaceShell.
//
// RpcTarget comes from capnweb rather than `cloudflare:workers`.
// Per capnweb's docs, that import is an alias for the workerd
// builtin when running under workerd, so the runtime behaviour is
// identical; the difference is that capnweb's export resolves
// under both workerd and node (tests, type-only consumers), while
// `cloudflare:workers` only resolves under workerd.

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
import { trackStub, untrackStub } from "@cloudflare/workspace-rpc/debug";
import { RpcTarget } from "capnweb";

import type { ShareOptions } from "./assets/index.js";
import type { GitCliInput, GitCliResult } from "./git/index.js";
import { withSpan } from "./observe.js";
import type { ExecResult } from "./shell.js";
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

// Exec handle returned from WorkspaceShellStub.exec. Holds the
// underlying ExecHandle on the DO side and exposes only the
// run-and-wait half of its API — result() — because Workers RPC
// can't carry the non-byte event stream that ExecHandle is.
//
// kill() and event streaming are deliberately omitted for now;
// they'd need a byte-framed transport (SSE, length-prefixed
// JSON) and we don't have a caller for that yet. When that lands
// it goes here as a new method, not as a replacement for this
// one.
export class WorkspaceExecHandleStub<E extends "utf8" | undefined = undefined> extends RpcTarget {
  readonly #pending: Promise<ExecResult<E>>;

  constructor(pending: Promise<ExecResult<E>>) {
    super();
    this.#pending = pending;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  async result(): Promise<WorkspaceExecResult<E>> {
    const result = await this.#pending;
    return {
      exitCode: result.exitCode,
      // joinParts in shell.ts returns string for "utf8",
      // Uint8Array otherwise — exactly the
      // WorkspaceExecResult shape.
      stdout: result.stdout as WorkspaceExecResult<E>["stdout"],
      stderr: result.stderr as WorkspaceExecResult<E>["stderr"],
    };
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
    // flight. result() awaits the handle's own result() when the
    // caller asks.
    //
    // The whole bracket runs inside one `workspace.shell.exec` span
    // so the pre-exec push, the spawn, and the post-drain pull nest
    // underneath it on the observer's active context. Errors from
    // either side land on this span.
    const pending: Promise<ExecResult<"utf8" | undefined>> = withSpan(
      this.#ws.observer,
      "workspace.shell.exec",
      {
        "workspace.shell.cwd": options.cwd,
        "workspace.shell.encoding": options.encoding,
        "workspace.shell.backend": options.backend,
      },
      () =>
        options.encoding === "utf8"
          ? this.#ws.shell
              .exec(command, {
                cwd: options.cwd,
                encoding: "utf8",
                backend: options.backend,
              })
              .then((handle) => handle.result())
          : this.#ws.shell
              .exec(command, { cwd: options.cwd, backend: options.backend })
              .then((handle) => handle.result()),
      (span, outcome) => {
        if (!outcome.ok) return;
        span.setAttribute("workspace.shell.exit_code", outcome.value.exitCode);
        span.setAttribute("workspace.shell.pushed", outcome.value.pushed);
        span.setAttribute("workspace.shell.pulled", outcome.value.pulled);
        span.setAttribute("workspace.shell.skipped", outcome.value.skipped.length);
      },
    );
    return new WorkspaceExecHandleStub<"utf8" | undefined>(pending);
  }
}

// Top-level wrapper. Two sub-RpcTargets let callers use promise
// pipelining: `stub.fs.writeFile(...)` is one round trip, not two.
//
// Construct via `workspace.stub()` rather than directly — the
// Workspace owns the lifecycle and the stub just delegates.
//
// Note the name collision: the *type* `WorkspaceRPC` is also
// exported by @cloudflare/workspace-rpc as the wire contract
// between wsd and the DO. WorkspaceStub here is a different thing
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

  constructor(ws: Workspace) {
    super();
    this.#fs = new WorkspaceFilesystemStub(ws);
    this.#shell = new WorkspaceShellStub(ws);
    this.#git = new WorkspaceGitStub(ws);
    this.#assets = ws.assets === undefined ? undefined : new WorkspaceAssetsStub(ws);
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
}
