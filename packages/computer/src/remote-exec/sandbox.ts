/**
 * A container-backed target: the adapter a Durable Object with a container binding needs to
 * satisfy `ExecTarget`, and a ready-made base class that starts its container on demand, with
 * hooks for routing its network, for persisting it (snapshots) and for destroying it.
 */
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { CA_ENV, TRUST_CA_SCRIPT } from "./egress";
import type { ExecTarget, ExecTargetOptions, ExecTargetProcess } from "./target";

/** The parts of the platform's `ExecProcess` we use. */
interface PlatformProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | null | undefined;
  readonly stdout: ReadableStream<Uint8Array> | null | undefined;
  readonly stderr: ReadableStream<Uint8Array> | null | undefined;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

/** The parts of `ctx.container` we use. */
export interface PlatformContainer {
  readonly running: boolean;
  start(options?: Record<string, unknown>): void;
  exec(cmd: string[], options?: ExecTargetOptions): Promise<PlatformProcess>;
  setInactivityTimeout?(ms: number): Promise<void>;
  monitor(): Promise<void>;
  destroy?(reason?: unknown): Promise<void>;
  interceptAllOutboundHttp?(binding: Fetcher): Promise<void>;
  interceptOutboundHttps?(addr: string, binding: Fetcher): Promise<void>;
  snapshotContainer?(options?: {
    name?: string;
  }): Promise<{ id: string; size: number; name?: string }>;
  snapshotDirectory?(options: {
    dir: string;
    name?: string;
  }): Promise<{ id: string; size: number; dir: string; name?: string }>;
}

/**
 * Wraps the platform's process so it can be returned over Workers RPC. Read the streams with
 * `streams()`: a getter's result can be serialized more than once over RPC, which a JS-created
 * stream doesn't survive. A stream the process doesn't have is `null`, not `undefined`: over RPC,
 * a property that reads as undefined is reported as a method the receiver doesn't implement.
 */
export class ProcessHandle extends RpcTarget implements ExecTargetProcess {
  readonly #p: PlatformProcess;
  constructor(p: PlatformProcess) {
    super();
    this.#p = p;
  }
  get pid() {
    return this.#p.pid;
  }
  get stdin() {
    return this.#p.stdin ?? null;
  }
  get stdout() {
    return this.#p.stdout ?? null;
  }
  get stderr() {
    return this.#p.stderr ?? null;
  }
  get exitCode() {
    return this.#p.exitCode;
  }
  kill(signal?: number) {
    this.#p.kill(signal);
  }
  streams() {
    return {
      stdin: this.#p.stdin ?? null,
      stdout: this.#p.stdout ?? null,
      stderr: this.#p.stderr ?? null,
    };
  }
}

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
/** How long the container must stay idle before a snapshot is taken, by default. */
export const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 10 * 1000;
const ROOT = "0:0";

export interface ContainerExecOptions<Egress = undefined> {
  container: () => PlatformContainer | undefined;
  /** What to start the container with: an image or a snapshot, internet access, size. */
  startOptions: () => Record<string, unknown> | undefined;
  /** How long the container keeps running after the Durable Object goes idle, in ms. */
  inactivityTimeoutMs?: () => number;
  /**
   * Every process started has exited. To snapshot, use `snapshot` instead: it waits for the
   * container to settle, and holds commands back while it runs.
   */
  onIdle?: () => void;
  /**
   * Persist the container, such as with `container.snapshotContainer()` or
   * `snapshotDirectory()`, recording the result for the next `startOptions()`. It runs once the
   * container has been idle (no process running, no command on its way in) for
   * `snapshotDebounceMs`, and only if a command ran since the last one. While it runs, commands
   * queue and start in order once it settles, whether it succeeded or not: the platform's
   * exec() fails during a snapshot. A failed snapshot is logged and tried again at the next idle.
   *
   * It gets the platform's container. Call that directly; calling back into this `exec()`
   * would wait for the snapshot itself.
   */
  snapshot?: (container: PlatformContainer) => Promise<void>;
  /**
   * How long the container must stay idle before `snapshot` runs, in ms. Default 10 seconds. A
   * command in that window resets it, so short gaps between commands, like those between one
   * call's install check and its session, don't snapshot. The timer is held in memory: if the
   * Durable Object is evicted before it fires, that snapshot is skipped until the next idle.
   */
  snapshotDebounceMs?: () => number;
  /** The container stopped: cleanly (undefined) or with an error. */
  onStopped?: (error: unknown) => void;
  /**
   * Who processes run as when a call doesn't say. Default root (`0:0`), whatever the image's
   * `USER`: remote-exec installs itself under /usr/local/bin and keeps its state in /var/lib and
   * /run.
   */
  user?: string;
  /**
   * Where the container's HTTP and HTTPS go, given the `egress` value the call passed to
   * `exec()` (undefined if it passed none). Return a `Fetcher`, such as a `ctx.exports` entrypoint,
   * to intercept them all through it, or undefined to leave the network to the start options.
   * Asked before a command whenever the running container isn't routed yet.
   */
  outbound?: (egress: Egress | undefined) => Fetcher | undefined;
}

/**
 * `ExecTarget` over a container: starts it on first use, then execs in it. When `outbound` returns
 * a `Fetcher`, the container sends all its HTTP and HTTPS through it, trusts the intercepting CA,
 * and has no other network unless the start options turn `enableInternet` on. Plain, so it can be
 * tested without a Durable Object; `ExecSandbox` is the Durable Object that uses it.
 */
export class ContainerExec<Egress = undefined> implements ExecTarget {
  readonly #options: ContainerExecOptions<Egress>;
  #running = 0;
  /** Commands on their way in: waiting for a snapshot or a start, or for the platform's exec(). */
  #entering = 0;
  #starting: Promise<void> | undefined;
  /** Whether this object has routed the running container's egress and trusted its CA. */
  #routed = false;
  /** A command has run since the last snapshot. */
  #dirty = false;
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  /** The snapshot in progress; it never rejects. */
  #snapshotting: Promise<void> | undefined;
  /** Commands that arrived during the snapshot, released in order when it settles. */
  readonly #queue: (() => void)[] = [];

  constructor(options: ContainerExecOptions<Egress>) {
    this.#options = options;
  }

  get running(): number {
    return this.#running;
  }

  /** Whether a snapshot is in progress. */
  get snapshotting(): boolean {
    return this.#snapshotting !== undefined;
  }

  /** Resolves once no snapshot is in progress, after the commands queued before it. */
  #afterSnapshot(): Promise<void> {
    if (this.#snapshotting === undefined) return Promise.resolve();
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  #cancelSnapshot(): void {
    if (this.#snapshotTimer === undefined) return;
    clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = undefined;
  }

  /** (Re)start the debounce, if there is something to snapshot and nothing is using the container. */
  #scheduleSnapshot(): void {
    if (this.#options.snapshot === undefined || !this.#dirty) return;
    if (this.#running > 0 || this.#entering > 0 || this.#snapshotting !== undefined) return;
    this.#cancelSnapshot();
    const delay = this.#options.snapshotDebounceMs?.() ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS;
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = undefined;
      this.#takeSnapshot();
    }, delay);
  }

  #takeSnapshot(): void {
    const snapshot = this.#options.snapshot;
    if (snapshot === undefined || !this.#dirty) return;
    // A command that got in after the timer was set cancels it, so this is only a safeguard.
    if (this.#running > 0 || this.#entering > 0 || this.#snapshotting !== undefined) return;
    const container = this.#options.container();
    // A stopped container has nothing left to snapshot.
    if (!container?.running) {
      this.#dirty = false;
      return;
    }
    this.#dirty = false;
    this.#snapshotting = (async () => {
      try {
        await snapshot(container);
      } catch (error) {
        console.error("container snapshot failed", String(error));
        this.#dirty = true;
      } finally {
        this.#snapshotting = undefined;
        // A failure isn't retried until the next idle, so a broken snapshot can't loop.
        for (const release of this.#queue.splice(0)) release();
      }
    })();
  }

  /**
   * Waits for the snapshot in progress, if any. A command arriving meanwhile still queues behind
   * it; use this to know a snapshot has been written, in tests or before destroy.
   */
  async settled(): Promise<void> {
    await this.#snapshotting;
  }

  #get(): PlatformContainer {
    const container = this.#options.container();
    if (!container) throw new Error("this Durable Object has no container binding");
    return container;
  }

  /**
   * Commands wait for a start in progress: its intercepts and CA come before any of them. A
   * running container whose egress this object hasn't routed, because routing failed or the
   * Durable Object restarted, is routed again before the command: registering an intercept again
   * replaces it, and the CA script can run again.
   */
  async ensureRunning(egress?: Egress): Promise<void> {
    if (this.#starting !== undefined) return this.#starting;
    const container = this.#get();
    if (container.running && this.#routed) return;
    const outbound = this.#options.outbound?.(egress);
    if (container.running && outbound === undefined) return;
    const starting = container.running
      ? this.#route(container, outbound as Fetcher)
      : this.#start(container, outbound);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(container: PlatformContainer, outbound: Fetcher | undefined): Promise<void> {
    const options = this.#options.startOptions();
    this.#routed = false;
    try {
      container.start(
        outbound === undefined
          ? options
          : {
              enableInternet: false,
              ...options,
              env: { ...(options?.env as Record<string, string> | undefined), ...CA_ENV },
            },
      );
    } catch (error) {
      // Another call started it in the meantime.
      if (container.running || /already running/i.test(String(error))) return;
      throw error;
    }
    container.monitor().then(
      () => this.#options.onStopped?.(undefined),
      (error: unknown) => {
        // Also how a destroy() shows up (SIGKILL, exit 137): onStopped decides what it means.
        console.info("container stopped", String(error));
        this.#options.onStopped?.(error);
      },
    );
    await container
      .setInactivityTimeout?.(
        this.#options.inactivityTimeoutMs?.() ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      )
      .catch(() => undefined);
    if (outbound !== undefined) {
      await this.#route(container, outbound);
    }
  }

  async #route(container: PlatformContainer, outbound: Fetcher): Promise<void> {
    if (
      container.interceptAllOutboundHttp === undefined ||
      container.interceptOutboundHttps === undefined
    ) {
      throw new Error("this container can't route its egress: it has no outbound interception");
    }
    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps("*", outbound);
    const trust = await container.exec(["sh", "-c", TRUST_CA_SCRIPT], {
      user: ROOT,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      trust.exitCode,
      new Response(trust.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`the container can't trust its egress CA (exit ${exitCode}): ${stderr}`);
    }
    this.#routed = true;
  }

  async exec(
    cmd: string[],
    options?: ExecTargetOptions,
    egress?: Egress,
  ): Promise<ExecTargetProcess> {
    // Counted from the start, so no snapshot can begin between the wait and the platform's exec().
    this.#entering += 1;
    this.#cancelSnapshot();
    let process: PlatformProcess;
    try {
      await this.#afterSnapshot();
      await this.ensureRunning(egress);
      // exec() waits for a container that's still starting.
      process = await this.#get().exec(cmd, {
        ...options,
        user: options?.user ?? this.#options.user ?? ROOT,
      });
      this.#running += 1;
      this.#dirty = true;
    } finally {
      this.#entering -= 1;
      // A command that failed to start leaves the container as it was: snapshot only if it's dirty.
      this.#scheduleSnapshot();
    }
    const exited = () => {
      this.#running -= 1;
      if (this.#running === 0) this.#options.onIdle?.();
      this.#scheduleSnapshot();
    };
    process.exitCode.then(exited, exited);
    return new ProcessHandle(process);
  }

  /** Stops the container, after any snapshot in progress; a pending one is dropped. */
  async destroy(): Promise<void> {
    this.#cancelSnapshot();
    await this.#snapshotting;
    this.#dirty = false;
    const container = this.#get();
    if (container.running) await container.destroy?.();
  }
}

/**
 * A Durable Object whose container runs its image's entrypoint (or `sleep infinity`) and takes
 * commands through exec(). Subclasses choose the start options, may route the container's network
 * through `outbound()`, and may persist the container with `snapshot()`, which runs once commands
 * have been quiet for `snapshotDebounceMs()` and holds new commands back while it runs. The other
 * hooks are `onIdle()` after commands finish, `onStopped()` and `onDestroy()`.
 *
 * `Egress` is what callers may pass as `exec()`'s third argument, for `outbound()` to route the
 * container by: credentials to add, a stub that decides, anything that crosses Workers RPC.
 */
export abstract class ExecSandbox<E = unknown, Egress = undefined>
  extends DurableObject<E>
  implements ExecTarget
{
  protected abstract startOptions(): Record<string, unknown> | undefined;
  /**
   * How long the container keeps running after the last call. Default 10 minutes. A method, not a
   * field: the base constructor needs it before a subclass's fields exist.
   */
  protected inactivityTimeoutMs(): number {
    return DEFAULT_INACTIVITY_TIMEOUT_MS;
  }

  /**
   * Where the container's HTTP and HTTPS go, given the `egress` the call passed to exec(). Return
   * a `Fetcher`, usually an entrypoint of this Worker (`this.ctx.exports.MyEgress({ props })`),
   * and the container sends every HTTP and HTTPS request through it, with the intercepting CA
   * trusted and `enableInternet` off unless `startOptions()` turns it on. The default, undefined,
   * leaves the network to the start options.
   */
  protected outbound(_egress: Egress | undefined): Fetcher | undefined {
    return undefined;
  }

  /**
   * Persist the container, once it has been idle for `snapshotDebounceMs()` after commands ran.
   * Define it to snapshot; there is no default. Record what you take, and have `startOptions()`
   * start from it:
   *
   * ```ts
   * protected async snapshot(container: PlatformContainer) {
   *   const { id } = await container.snapshotContainer!();
   *   await this.ctx.storage.put("snapshot", id);
   * }
   * ```
   *
   * Commands that arrive while it runs wait for it, in order. Use `container` directly, not
   * `this.exec()`, which would wait for this snapshot.
   */
  protected snapshot?(container: PlatformContainer): Promise<void>;

  /** How long the container must be idle before `snapshot()` runs, in ms. Default 10 seconds. */
  protected snapshotDebounceMs(): number {
    return DEFAULT_SNAPSHOT_DEBOUNCE_MS;
  }

  readonly #exec: ContainerExec<Egress>;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    const container = () => (this.ctx as unknown as { container?: PlatformContainer }).container;
    this.#exec = new ContainerExec<Egress>({
      container,
      startOptions: () => this.startOptions(),
      inactivityTimeoutMs: () => this.inactivityTimeoutMs(),
      onIdle: () => this.onIdle(),
      onStopped: (error) => this.onStopped(error),
      outbound: (egress) => this.outbound(egress),
      // Subclass methods are on the prototype, so this sees one defined there.
      snapshot: this.#snapshotHook(),
      snapshotDebounceMs: () => this.snapshotDebounceMs(),
    });
    // A Durable Object that restarts while its container runs starts without a timeout.
    const running = container();
    if (running?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await running.setInactivityTimeout?.(this.inactivityTimeoutMs()).catch(() => undefined);
      });
    }
  }

  /**
   * `ctx.container.exec()`, starting the container first if it isn't running. `egress` is given
   * to `outbound()` when the container's network isn't routed yet.
   */
  async exec(
    cmd: string[],
    options?: ExecTargetOptions,
    egress?: Egress,
  ): Promise<ExecTargetProcess> {
    return this.#exec.exec(cmd, options, egress);
  }

  /** Stops the container and forgets it. */
  async destroy(): Promise<void> {
    await this.#exec.destroy();
    await this.onDestroy();
  }

  protected get busy(): boolean {
    return this.#exec.running > 0;
  }

  #snapshotHook(): ((container: PlatformContainer) => Promise<void>) | undefined {
    const snapshot = this.snapshot;
    return snapshot === undefined ? undefined : (container) => snapshot.call(this, container);
  }

  /** Whether `snapshot()` is running; commands wait for it. */
  protected get snapshotting(): boolean {
    return this.#exec.snapshotting;
  }

  protected onIdle(): void {}
  protected onStopped(_error: unknown): void {}
  protected async onDestroy(): Promise<void> {}
}

/** The part of a sandbox that takes an egress with each command, such as an `ExecSandbox` stub. */
export interface EgressTarget<Egress> {
  exec(
    cmd: string[],
    options: ExecTargetOptions | undefined,
    egress: Egress,
  ): Promise<ExecTargetProcess>;
}

/**
 * An `ExecTarget` that passes `egress` with every command, for `createExecModule()`'s `target`:
 *
 * ```ts
 * target: () => withEgress(env.SANDBOX.getByName(id), { token }),
 * ```
 */
export function withEgress<Egress>(sandbox: EgressTarget<Egress>, egress: Egress): ExecTarget {
  return { exec: (cmd, options) => sandbox.exec(cmd, options, egress) };
}
