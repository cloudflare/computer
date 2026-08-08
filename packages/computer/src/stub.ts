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
//   const handle = await ws.runtime.exec("ls /workspace");
//   const { exitCode, stdout, stderr } = await handle.result();
//
// All the SyncRPC streaming (push / pushObjects / fetchObjects /
// fetchChanges) happens on the capnweb wire inside the DO. What
// crosses the Workers-RPC boundary here is only the high-level
// value-shaped facade — writeFile / readFile / stat / exec —
// because Workers RPC doesn't carry non-byte ReadableStreams or
// capnweb stubs.
//
// Runtime event streams cross Workers RPC as newline-delimited byte frames.
// The handle exposes the same single-consumer result, stream, kill, backend,
// and disposal surface as a local runtime handle.
//
// RpcTarget comes from capnweb rather than `cloudflare:workers`.
// Per capnweb's docs, that import is an alias for the workerd
// builtin when running under workerd, so the runtime behaviour is
// identical; the difference is that capnweb's export resolves
// under both workerd and node (tests, type-only consumers), while
// `cloudflare:workers` only resolves under workerd.

import { trackStub, untrackStub } from "@cloudflare/computer-rpc/debug";
import type {
  FindOptions,
  GrepOptions,
  MkdirOptions,
  ReaddirOptions,
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
import type { GitCliInput, GitCliResult } from "./git/index.js";
import { withSpan } from "./observe.js";
import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions,
  WorkspaceRuntimeResult,
} from "./runtime/types.js";
import { encodeRuntimeEvent } from "./runtime/wire.js";
import type { Workspace } from "./workspace.js";

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
  readFile(
    path: string,
    options: ReadFileOptions & { encoding?: undefined },
  ): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, options: ReadFileOptions & { encoding: "utf8" }): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    return withSpan(this.#ws.observer, "workspace.fs.readFile", { "workspace.fs.path": path }, () =>
      this.#ws.fs.readFile(path, optionsOrEncoding as ReadFileOptions),
    );
  }

  exists(path: string): Promise<boolean> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.exists",
      { "workspace.fs.path": path },
      async () => (await this.statOrNull(path)) !== null,
    );
  }

  stat(path: string): Promise<WorkspaceStatResult> {
    return withSpan(this.#ws.observer, "workspace.fs.stat", { "workspace.fs.path": path }, () =>
      this.#ws.fs.stat(path),
    );
  }

  async statOrNull(path: string): Promise<WorkspaceStatResult | null> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.statOrNull",
      { "workspace.fs.path": path },
      async () => {
        try {
          return await this.#ws.fs.stat(path);
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        }
      },
    );
  }

  lstat(path: string): Promise<WorkspaceStatResult> {
    return withSpan(this.#ws.observer, "workspace.fs.lstat", { "workspace.fs.path": path }, () =>
      this.#ws.fs.lstat(path),
    );
  }

  async lstatOrNull(path: string): Promise<WorkspaceStatResult | null> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.lstatOrNull",
      { "workspace.fs.path": path },
      async () => {
        try {
          return await this.#ws.fs.lstat(path);
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        }
      },
    );
  }

  readlink(path: string): Promise<string> {
    return withSpan(this.#ws.observer, "workspace.fs.readlink", { "workspace.fs.path": path }, () =>
      this.#ws.fs.readlink(path),
    );
  }

  readdir(path: string, options: ReaddirOptions = {}): Promise<WorkspaceDirentResult[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.readdir",
      { "workspace.fs.path": path },
      () => this.#ws.fs.readdir(path, options),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.fs.entries", outcome.value.length);
      },
    );
  }

  find(
    directory: string,
    pattern?: string,
    options: FindOptions = {},
  ): Promise<WorkspaceFoundEntry[]> {
    return withSpan(
      this.#ws.observer,
      "workspace.fs.find",
      { "workspace.fs.path": directory, "workspace.fs.pattern": pattern },
      () => this.#ws.fs.find(directory, pattern, options),
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

export class WorkspaceRuntimeExecHandleStub<
  E extends "utf8" | undefined = undefined,
> extends RpcTarget {
  readonly #handle: WorkspaceRuntimeExecHandle<E>;
  #consumed = false;
  #disposed = false;
  #reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<"utf8" | undefined>> | undefined;

  constructor(handle: WorkspaceRuntimeExecHandle<E>) {
    super();
    this.#handle = handle;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const reader = this.#reader;
    this.#reader = undefined;
    if (reader) {
      void reader
        .cancel()
        .catch(() => undefined)
        .finally(() => reader.releaseLock());
    } else {
      const cancel = (this.#handle as { cancel?: () => Promise<void> }).cancel;
      if (typeof cancel === "function") void cancel.call(this.#handle).catch(() => undefined);
    }
    untrackStub(this);
  }

  get id(): string {
    return this.#handle.id;
  }

  get backend(): string {
    return this.#handle.backend;
  }

  async result(): Promise<WorkspaceRuntimeResult<E>> {
    this.#claim();
    return this.#handle.result();
  }

  stream(): ReadableStream<Uint8Array> {
    this.#claim();
    const reader = (
      this.#handle as ReadableStream<WorkspaceRuntimeEvent<"utf8" | undefined>>
    ).getReader();
    this.#reader = reader;
    const owner = this;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              reader.releaseLock();
              owner.#reader = undefined;
              controller.close();
              return;
            }
            controller.enqueue(encodeRuntimeEvent(value));
          } catch (error) {
            reader.releaseLock();
            owner.#reader = undefined;
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
            owner.#reader = undefined;
          }
        },
      },
      { highWaterMark: 0 },
    );
  }

  #claim() {
    if (this.#consumed) {
      throw new Error("runtime handle already consumed: result() and stream() are single-shot");
    }
    this.#consumed = true;
  }

  kill(signal?: WorkspaceRuntimeKillOptions["signal"]): Promise<void> {
    return this.#handle.kill(signal);
  }
}

export class WorkspaceRuntimeStub extends RpcTarget {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    super();
    this.#ws = ws;
    trackStub(this);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }

  exec(source: string): Promise<WorkspaceRuntimeExecHandleStub<undefined>>;
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<"utf8">,
  ): Promise<WorkspaceRuntimeExecHandleStub<"utf8">>;
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<undefined>,
  ): Promise<WorkspaceRuntimeExecHandleStub<undefined>>;
  async exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<"utf8" | undefined> = {},
  ): Promise<WorkspaceRuntimeExecHandleStub<"utf8" | undefined>> {
    await this.#ws.ready(options.backend);
    const handle = await (
      this.#ws.runtime.exec as unknown as (
        source: string,
        options: WorkspaceRuntimeExecOptions<"utf8" | undefined>,
      ) => Promise<WorkspaceRuntimeExecHandle<"utf8" | undefined>>
    )(source, options);
    if (options.id !== undefined && handle.id !== options.id) {
      throw new Error(`backend ran exec as ${handle.id}, not the requested id ${options.id}`);
    }
    return new WorkspaceRuntimeExecHandleStub(handle);
  }

  getExec(id: string): Promise<WorkspaceRuntimeExecHandleStub<undefined>>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<"utf8">,
  ): Promise<WorkspaceRuntimeExecHandleStub<"utf8">>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<undefined>,
  ): Promise<WorkspaceRuntimeExecHandleStub<undefined>>;
  async getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<"utf8" | undefined> = {},
  ): Promise<WorkspaceRuntimeExecHandleStub<"utf8" | undefined>> {
    await this.#ws.ready(options.backend);
    const handle = await (
      this.#ws.runtime.getExec as unknown as (
        id: string,
        options: WorkspaceRuntimeGetOptions<"utf8" | undefined>,
      ) => Promise<WorkspaceRuntimeExecHandle<"utf8" | undefined>>
    )(id, options);
    return new WorkspaceRuntimeExecHandleStub(handle);
  }

  killExec(id: string, options: WorkspaceRuntimeKillOptions = {}): Promise<void> {
    return this.#ws.runtime.killExec(id, options);
  }

  disposeExec(id: string, options: { backend?: string } = {}): Promise<void> {
    return this.#ws.runtime.disposeExec(id, options);
  }
}

// Assets half. Pure value returns: `publish(path, { expiresAfter })
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

// Top-level wrapper. Two sub-RpcTargets let callers use promise
// pipelining: `stub.fs.writeFile(...)` is one round trip, not two.
//
// Construct via `workspace.stub()` rather than directly — the
// Workspace owns the lifecycle and the stub just delegates.
//
// Note the name collision: the *type* `WorkspaceRPC` is also
// exported by @cloudflare/computer-rpc as the wire contract
// between wsd and the DO. WorkspaceStub here is a different thing
// (the Workers-RPC value carried between the DO and a Worker), so
// the name doesn't clash.
export class WorkspaceStub extends RpcTarget {
  // Getters rather than instance properties so Workers RPC
  // exposes them through the stub proxy. Plain readonly fields
  // set in the constructor land as private isolate state and the
  // proxy reports "method not implemented".
  readonly #fs: WorkspaceFilesystemStub;
  readonly #runtime: WorkspaceRuntimeStub;
  readonly #git: WorkspaceGitStub;
  readonly #assets: WorkspaceAssetsStub | undefined;
  readonly #artifacts: WorkspaceArtifactsStub;
  readonly #useThink: boolean;

  constructor(ws: Workspace) {
    super();
    this.#fs = new WorkspaceFilesystemStub(ws);
    this.#runtime = new WorkspaceRuntimeStub(ws);
    this.#git = new WorkspaceGitStub(ws);
    this.#assets = ws.assets === undefined ? undefined : new WorkspaceAssetsStub(ws);
    this.#artifacts = new WorkspaceArtifactsStub(ws.artifacts);
    this.#useThink = ws.useThink;
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
    this.#runtime[Symbol.dispose]();
    this.#git[Symbol.dispose]();
    this.#assets?.[Symbol.dispose]();
    this.#artifacts[Symbol.dispose]();
    untrackStub(this);
  }

  get fs(): WorkspaceFilesystemStub {
    return this.#fs;
  }

  get useThink(): boolean {
    return this.#useThink;
  }

  get runtime(): WorkspaceRuntimeStub {
    return this.#runtime;
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
