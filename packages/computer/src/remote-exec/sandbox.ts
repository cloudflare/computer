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
const ROOT = "0:0";

export interface ContainerExecOptions<Egress = undefined> {
  container: () => PlatformContainer | undefined;
  /** What to start the container with: an image or a snapshot, internet access, size. */
  startOptions: () => Record<string, unknown> | undefined;
  /** How long the container keeps running after the Durable Object goes idle, in ms. */
  inactivityTimeoutMs?: () => number;
  /** Every process started has exited: a moment to snapshot, say. */
  onIdle?: () => void;
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
  #starting: Promise<void> | undefined;
  /** Whether this object has routed the running container's egress and trusted its CA. */
  #routed = false;

  constructor(options: ContainerExecOptions<Egress>) {
    this.#options = options;
  }

  get running(): number {
    return this.#running;
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
    await this.ensureRunning(egress);
    // exec() waits for a container that's still starting.
    const process = await this.#get().exec(cmd, {
      ...options,
      user: options?.user ?? this.#options.user ?? ROOT,
    });
    this.#running += 1;
    const exited = () => {
      this.#running -= 1;
      if (this.#running === 0) this.#options.onIdle?.();
    };
    process.exitCode.then(exited, exited);
    return new ProcessHandle(process);
  }

  async destroy(): Promise<void> {
    const container = this.#get();
    if (container.running) await container.destroy?.();
  }
}

/**
 * A Durable Object whose container runs its image's entrypoint (or `sleep infinity`) and takes
 * commands through exec(). Subclasses choose the start options, may route the container's network
 * through `outbound()`, and may persist the container through the hooks: `onIdle()` after
 * commands finish, `onStopped()`, `onDestroy()`.
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
