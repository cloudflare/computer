// KitebuildBackend: shell commands on a Kitebuild machine, the BusyBox
// userland busyworker runs inside a Worker by emulating the Linux
// syscall ABI.
//
// The machine lives in the Durable Object that owns the Workspace and
// mounts the Workspace store directly (./workspace-mount.ts), so the
// handle declares sync: "none". Commands are real processes: pipes,
// background jobs and signals work, and output streams as it is
// written. `git` is Kitebuild's git by default, working on the
// machine's own files, or the Workspace's git client when asked. The
// Worker shell's `assets` and `artifacts` commands are built in
// (./workspace-commands.ts); other programs beyond BusyBox come from
// toolsets the caller installs and passes in.

import type { ExecEvent, ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import {
  coalesceChanges,
  currentRev,
  type Database,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import {
  type EgressPolicy,
  type FsNode,
  type LocalFetcher,
  Machine,
  ProgramRegistry,
  type Toolset,
} from "@cloudflare/kitebuild-core";
import BUSYBOX from "@cloudflare/kitebuild-core/artifacts/busybox.wasm";
import INITRAMFS from "@cloudflare/kitebuild-core/artifacts/initramfs.wasm";
import { git as kitebuildGit } from "@cloudflare/kitebuild-git";

import type { BackendHandle, WorkspaceBackend, WorkspaceBackendHost } from "../../backend";
import type { WorkspaceEgressPolicy } from "../../runtime/egress";
import { ExecJournal } from "./exec-journal";
import { workspacePrograms } from "./workspace-commands";
import { mountWorkspace, type WorkspaceMount } from "./workspace-mount";

export interface KitebuildBackendOptions {
  /** Selector for runtime.exec({ backend }). Defaults to "kitebuild". */
  id?: string;
  /**
   * Commands beyond BusyBox, as Kitebuild toolsets: programs for the
   * machine's PATH, each with the host values it needs. A toolset's
   * `extras` are merged into the machine's extras.
   */
  commands?: readonly Toolset[];
  /**
   * Workspace directories mounted at the same path in the machine.
   * Created in the Workspace when missing. Defaults to ["/workspace"].
   */
  paths?: readonly string[];
  /** Outbound network for commands. Defaults to { mode: "none" }. */
  egress?: WorkspaceEgressPolicy;
  /** Most file bytes cached in memory for reads. Defaults to 8 MiB. */
  cacheBytes?: number;
  /** Environment every command starts with, before its own `env`. */
  env?: Record<string, string>;
  /** Most commands running at once. Defaults to 4. */
  maxExecs?: number;
  /**
   * Which `git` the shell has. "kitebuild" (the default) is Kitebuild's
   * git (@cloudflare/kitebuild-git), run on the machine's own files. Its
   * HTTP follows `egress` like every other command, which Kitebuild checks
   * for every request and redirect: refused under "none", sent directly
   * under "direct", and handed to the gateway under "http-gateway".
   * `{ fetch }` puts a step in front of every request the policy lets
   * out, sent directly or to the gateway, for example to add credentials;
   * it sends each one on with the `send` it is given. "workspace" is the
   * Workspace's git client, as in the Worker shell, which runs on the host
   * and does not follow `egress`. A toolset program at /usr/bin/git
   * replaces any.
   */
  git?: "kitebuild" | "workspace" | { fetch: KitebuildGitFetch };
}

/** A caller's step in front of Kitebuild git's HTTP; see `KitebuildBackendOptions.git`. */
export type KitebuildGitFetch = (
  request: Request,
  send: (request: Request) => Promise<Response>,
) => Promise<Response>;

const DEFAULT_ENV = { HOME: "/root", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb" };
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as const;
const KILL_GRACE_MS = 5_000;
const CHAR_DEVICE = 0o020000;
// Most output bytes joined into one event.
const OUTPUT_BATCH_BYTES = 32 * 1024;

/**
 * Runs shell commands on a Kitebuild machine in the host Durable Object.
 *
 * Experimental: this API may change in any release and is not yet
 * suitable for production use.
 */
export class KitebuildBackend implements WorkspaceBackend {
  readonly type = "kitebuild";
  readonly id: string;
  readonly description: string;
  readonly #options: KitebuildBackendOptions;

  constructor(options: KitebuildBackendOptions = {}) {
    this.id = options.id ?? "kitebuild";
    this.#options = options;
    const extra = (options.commands ?? []).flatMap((toolset) =>
      toolset.programs.map((p) => p.path.split("/").pop()),
    );
    const more =
      extra.length > 0 ? `, plus ${extra.join(", ")}.` : ". Cannot run binaries outside that set.";
    this.description = `A BusyBox Linux userland in the Workspace's Durable Object, with real processes, pipes, background jobs and signals, and output that streams as it is written. Workspace files are shared directly with the file tools. Has sh, awk, sed, grep, find, xargs, tar, gzip, xz, diff, patch, vi, wget and the rest of BusyBox, git, and the assets and artifacts commands${more}`;
  }

  async connect(host: WorkspaceBackendHost): Promise<BackendHandle> {
    const runtime = new KitebuildRuntime(this.id, host, this.#options);
    const rpc: WorkspaceRPC = { sync: refuseSync(), shell: runtime.shell() };
    return { rpc, sync: "none", close: async () => runtime.close() };
  }
}

interface ExecLog {
  events: ExecEvent[];
  done: boolean;
  listeners: Set<() => void>;
  pgid?: number;
  timer?: ReturnType<typeof setTimeout>;
}

class KitebuildRuntime {
  readonly #machine: Machine;
  readonly #mounts: WorkspaceMount[];
  readonly #host: WorkspaceBackendHost;
  readonly #env: Record<string, string>;
  readonly #maxExecs: number;
  /** Running executions; finished ones are in the journal. */
  readonly #execs = new Map<string, ExecLog>();
  readonly #journal: ExecJournal;
  #running = 0;
  // The Workspace revision the mounts are up to date with.
  #rev: number;
  // Every revision from #rev up to this one is the machine's own write,
  // which the mounts already hold, so the next refresh starts here.
  #ownThrough: number;
  // Whether something outside wrote, and the machine wrote after it, since
  // #rev. The change feed reports each path's latest revision only, so the
  // machine's later write, even a touch or a chmod, would hide the outside
  // write to that path; the next refresh then starts from #rev.
  #interleaved = false;

  constructor(backendId: string, host: WorkspaceBackendHost, options: KitebuildBackendOptions) {
    this.#host = host;
    this.#journal = new ExecJournal(host.db, backendId);
    this.#env = { ...DEFAULT_ENV, ...options.env };
    this.#maxExecs = options.maxExecs ?? 4;
    const gitOption = options.git ?? "kitebuild";
    // The applet's toolset comes first, so a caller's toolset still replaces it.
    const toolsets = [
      ...(gitOption === "workspace"
        ? []
        : [
            // Pushing is allowed, as with the Workspace's git client; credentials
            // come from the environment or from the caller's fetch. Commits fall
            // back to the Workspace's default identity, as its git client's do.
            kitebuildGit({
              push: true,
              ...(gitOption === "kitebuild" ? {} : { step: gitOption.fetch }),
              ...(host.defaultGitIdentity === undefined
                ? {}
                : { defaultIdentity: host.defaultGitIdentity }),
            }),
          ]),
      ...(options.commands ?? []),
    ];
    this.#machine = new Machine({
      programs: new ProgramRegistry({
        defaultProgram: { module: BUSYBOX, abi: "linux" },
        // Built-in commands first, so a toolset can replace them.
        programs: [
          ...workspacePrograms({
            host,
            git: gitOption === "workspace",
            flush: () => {
              for (const mount of this.#mounts) mount.flush();
            },
            refreshAfter: (since) => this.#refresh(since),
          }),
          ...toolsets.flatMap((toolset) => toolset.programs),
        ],
      }),
      initramfs: INITRAMFS,
      egress: egressPolicy(options.egress ?? { mode: "none" }),
      extras: Object.assign({}, ...toolsets.map((toolset) => toolset.extras ?? {})),
      wsSend() {},
      log() {},
    });
    this.#machine.setupFs();
    const provider = recordingWrites(new SQLiteWorkspaceProvider(host.db), host.db, (from, to) => {
      if (from !== this.#ownThrough) this.#interleaved = true;
      this.#ownThrough = to;
    });
    this.#mounts = (options.paths ?? ["/workspace"]).map((path) => {
      // Only when missing: dofs refuses mkdir on a directory that holds a
      // read-only mount, even one that already exists.
      if (!provider.existsSync(path)) provider.mkdirSync(path, { recursive: true });
      return mountWorkspace(this.#machine.vfs, path, provider, { cacheBytes: options.cacheBytes });
    });
    // Creating the mounted paths above went through the recording provider.
    this.#rev = currentRev(host.db);
    this.#ownThrough = this.#rev;
    this.#interleaved = false;
  }

  shell(): ShellRPC {
    return {
      exec: (input) => this.#exec(input),
      getExec: async ({ id, after }) => ({ id, events: this.#stream(this.#log(id), after) }),
      killExec: async ({ id, signal }) => {
        const log = this.#log(id);
        if (!log.done && log.pgid !== undefined)
          this.#machine.killGroup(log.pgid, SIGNALS[signal ?? "SIGTERM"]);
      },
      disposeExec: async ({ id }) => {
        if (this.#execs.has(id)) return;
        this.#journal.dispose(id);
      },
    };
  }

  close(): void {
    for (const log of this.#execs.values()) clearTimeout(log.timer);
    // Every live process, background jobs of finished commands included.
    const groups = new Set<number>();
    for (const proc of this.#machine.processes.values()) {
      if (!proc.exited) groups.add(proc.pgid);
    }
    for (const pgid of groups) this.#machine.killGroup(pgid, SIGNALS.SIGKILL);
    for (const mount of this.#mounts) mount.flush();
  }

  async #exec(
    input: Parameters<ShellRPC["exec"]>[0],
  ): Promise<{ id: string; events: ReadableStream<ExecEvent> }> {
    // Pick up Workspace writes made outside the machine since the last
    // look. The tree keeps its nodes, so running commands are unaffected.
    //
    // A second exec can arrive while this refresh is awaited, see the rev
    // already moved, and spawn at once. That is safe only because the
    // refresh never waits on real I/O (the SQLite reads and mount updates
    // are synchronous) and Kitebuild waits a timer tick before a new
    // process runs, so the refresh always finishes first. If either
    // changes, share one in-flight refresh between execs.
    const rev = currentRev(this.#host.db);
    if (rev !== this.#rev) {
      const since = this.#interleaved ? this.#rev : this.#ownThrough;
      this.#rev = rev;
      this.#ownThrough = rev;
      this.#interleaved = false;
      if (since !== rev) await this.#refresh(since);
    }

    const id = input.id ?? crypto.randomUUID();
    if (this.#execs.has(id)) throw shellError("EEXEC_BUSY", `exec ${id} is already running`);
    if (this.#running >= this.#maxExecs) {
      throw shellError("EEXEC_BUSY", `${this.#running} commands are already running`);
    }

    const log: ExecLog = { events: [], done: false, listeners: new Set() };
    this.#execs.set(id, log);
    this.#journal.prune();
    this.#journal.start(id);
    let seq = 0;
    // Memory holds what the journal keeps, so a run's output is bounded
    // by the journal's limit, live and on replay alike.
    const publish = (kept: ExecEvent[]): void => {
      if (kept.length === 0) return;
      log.events.push(...kept);
      seq = kept[kept.length - 1].seq;
      for (const listener of log.listeners) listener();
    };
    const emit = (event: ExecEvent): void => publish(this.#journal.append(event));
    const batch = outputBatch((name, bytes) => emit({ id, seq: ++seq, name, value: bytes }));
    const output = (name: "stdout" | "stderr") => outputNode((bytes) => batch.write(name, bytes));

    const env = { ...this.#env, ...input.env };
    const proc = this.#machine.spawn({
      argv: ["sh", "-c", input.source],
      envp: Object.entries(env).map(([name, value]) => `${name}=${value}`),
      fdEntries: new Map([
        [0, { node: inputNode(input.stdin), flags: 0, offset: 0 }],
        [1, { node: output("stdout"), flags: 1, offset: 0 }],
        [2, { node: output("stderr"), flags: 1, offset: 0 }],
      ]),
      cwd: input.cwd ?? "/",
      parentPid: 0,
    });
    log.pgid = proc.pgid;
    this.#running++;

    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      log.timer = setTimeout(() => {
        this.#machine.killGroup(proc.pgid, SIGNALS.SIGTERM);
        log.timer = setTimeout(
          () => this.#machine.killGroup(proc.pgid, SIGNALS.SIGKILL),
          KILL_GRACE_MS,
        );
      }, input.timeoutMs);
    }

    void proc.exitedPromise.then((code) => {
      clearTimeout(log.timer);
      this.#running--;
      let exitCode = code;
      batch.flush();
      try {
        for (const mount of this.#mounts) mount.flush();
      } catch (error) {
        const message = new TextEncoder().encode(
          `kitebuild: saving files failed: ${String(error)}\n`,
        );
        // A note, so it is kept even after output past the cap was dropped.
        publish(this.#journal.appendNote({ id, seq: ++seq, name: "stderr", value: message }));
        if (exitCode === 0) exitCode = 1;
      }
      log.done = true;
      emit({ id, seq: ++seq, name: "exit", code: exitCode });
      this.#journal.finish(id, exitCode);
      // Streams already open keep the log; getExec replays from the journal.
      this.#execs.delete(id);
    });

    return { id, events: this.#stream(log, undefined) };
  }

  // Apply every Workspace path changed after `since` to the mounts.
  async #refresh(since: number): Promise<void> {
    const changed: string[] = [];
    for await (const entry of coalesceChanges(this.#host.db, since)) changed.push(entry.path);
    for (const mount of this.#mounts) mount.refresh(changed);
  }

  // A running execution from memory, or a finished one replayed from
  // the journal.
  #log(id: string): ExecLog {
    const log = this.#execs.get(id);
    if (log !== undefined) return log;
    const events = this.#journal.load(id);
    if (events === undefined) throw shellError("ENOENT", `no such exec: ${id}`);
    return { events, done: true, listeners: new Set() };
  }

  #stream(log: ExecLog, after: number | "tail" | undefined): ReadableStream<ExecEvent> {
    let next =
      after === "tail"
        ? log.events.length
        : after === undefined
          ? 0
          : log.events.findIndex((e) => e.seq > after);
    if (next < 0) next = log.events.length;
    let wake: (() => void) | undefined;
    return new ReadableStream<ExecEvent>({
      pull: async (controller) => {
        while (next >= log.events.length) {
          if (log.done) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            log.listeners.add(resolve);
          });
          if (wake) log.listeners.delete(wake);
        }
        const event = log.events[next++];
        controller.enqueue(event);
        if (event.name === "exit") controller.close();
      },
      cancel: () => {
        if (wake) log.listeners.delete(wake);
      },
    });
  }
}

// Joins consecutive writes to one stream into one event, so a chatty
// program does not cost an event and a journal row per write. The
// batch goes out when the other stream is written, when it reaches
// OUTPUT_BATCH_BYTES, or on the next timer tick.
function outputBatch(send: (name: "stdout" | "stderr", bytes: Uint8Array) => void) {
  let name: "stdout" | "stderr" = "stdout";
  let chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (chunks.length === 0) return;
    const bytes = chunks.length === 1 ? chunks[0] : new Uint8Array(size);
    if (chunks.length > 1) {
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    chunks = [];
    size = 0;
    send(name, bytes);
  };
  return {
    write(stream: "stdout" | "stderr", bytes: Uint8Array): void {
      if (stream !== name) flush();
      name = stream;
      chunks.push(bytes);
      size += bytes.byteLength;
      if (size >= OUTPUT_BATCH_BYTES) flush();
      else timer ??= setTimeout(flush, 0);
    },
    flush,
  };
}

// A write-only character device that hands every write to `sink`.
function outputNode(sink: (bytes: Uint8Array) => void): FsNode {
  return {
    type: "char",
    mode: CHAR_DEVICE | 0o666,
    uid: 0,
    gid: 0,
    mtime: 0,
    ino: 0,
    special: {
      write: (memory, buf, count) => {
        if (count > 0) sink(memory.slice(buf, buf + count));
        return count;
      },
      read: () => 0,
      poll: () => 4,
    },
  };
}

// A read-only character device serving `bytes`, then end of file.
function inputNode(bytes: Uint8Array | undefined): FsNode {
  let offset = 0;
  return {
    type: "char",
    mode: CHAR_DEVICE | 0o444,
    uid: 0,
    gid: 0,
    mtime: 0,
    ino: 0,
    special: {
      read: (memory, buf, count) => {
        if (bytes === undefined || offset >= bytes.byteLength) return 0;
        const n = Math.min(count, bytes.byteLength - offset);
        memory.set(bytes.subarray(offset, offset + n), buf);
        offset += n;
        return n;
      },
      write: () => -9,
      poll: () => 1,
    },
  };
}

function egressPolicy(policy: WorkspaceEgressPolicy): EgressPolicy | undefined {
  switch (policy.mode) {
    case "none":
      return () => "deny";
    case "direct":
      return undefined;
    case "http-gateway": {
      // Every connection goes to the gateway as HTTP, by the Host the
      // guest sent, so names only have to resolve to something. Answer
      // every lookup locally instead of sending DNS through the gateway.
      const gateway = policy.gateway as unknown as LocalFetcher;
      return (target) => (target.kind === "dns" ? LOCAL_RESOLVER : gateway);
    }
    default: {
      // Undefined would mean unrestricted network, so a new mode must not
      // fall through to it.
      const unknown: never = policy;
      throw new Error(`KitebuildBackend: unsupported egress mode ${JSON.stringify(unknown)}`);
    }
  }
}

// Gateway-mode DNS: answers each A query with one unroutable address
// and every other query with no records.
const GATEWAY_ADDRESS = [192, 0, 2, 1];
const LOCAL_RESOLVER: LocalFetcher = {
  async fetch(_input: RequestInfo | URL, init?: RequestInit) {
    const query = new Uint8Array(await new Response(init?.body).arrayBuffer());
    return new Response(dnsAnswer(query), {
      headers: { "content-type": "application/dns-message" },
    });
  },
};

function dnsAnswer(query: Uint8Array): Uint8Array<ArrayBuffer> {
  let end = 12;
  while (end < query.length && query[end] !== 0) end += query[end] + 1;
  end += 5;
  if (end > query.length) return new Uint8Array(0);
  const isA = query[end - 4] === 0 && query[end - 3] === 1;
  const record = isA ? [0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...GATEWAY_ADDRESS] : [];
  const response = new Uint8Array(end + record.length);
  response.set(query.subarray(0, end));
  response[2] |= 0x80;
  response[3] = 0x80;
  response[5] = 1;
  response.fill(0, 6, 12);
  response[7] = isA ? 1 : 0;
  response.set(record, end);
  return response;
}

function shellError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function refuseSync(): SyncRPC {
  const refuse = (name: string): never => {
    throw new Error(
      `KitebuildBackend: sync.${name} must not be called; the handle declares sync: "none"`,
    );
  };
  return {
    push: () => refuse("push"),
    fetchChanges: () => refuse("fetchChanges"),
    readEntry: () => refuse("readEntry"),
    hasObjects: () => refuse("hasObjects"),
    fetchObjects: () => refuse("fetchObjects"),
    pushObjects: () => refuse("pushObjects"),
    watermarks: () => refuse("watermarks"),
  };
}

// The provider methods that write to the Workspace store.
const WRITES = [
  "mkdirSync",
  "rmdirSync",
  "unlinkSync",
  "linkSync",
  "renameSync",
  "symlinkSync",
  "chmodSync",
  "utimesSync",
  "writeFileSync",
  "writeRangeSync",
  "truncateFileSync",
  "openWriteBufferSync",
  "openWriteBufferForCreateSync",
  "releaseWriteBufferSync",
] as const satisfies readonly (keyof SQLiteWorkspaceProvider)[];

// The provider, reporting the revisions each of its writes took. The calls
// are synchronous, so nothing else writes between the two reads.
function recordingWrites(
  provider: SQLiteWorkspaceProvider,
  db: Database,
  record: (from: number, to: number) => void,
): SQLiteWorkspaceProvider {
  const writes = new Set<PropertyKey>(WRITES);
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!writes.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const from = currentRev(db);
        try {
          return value.apply(target, args);
        } finally {
          const to = currentRev(db);
          if (to !== from) record(from, to);
        }
      };
    },
  });
}
