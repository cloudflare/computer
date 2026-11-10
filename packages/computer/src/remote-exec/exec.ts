/**
 * One remote exec call, from the Durable Object's side: session, push, prepare,
 * the raw run, pull, close. The streams of the returned process are exec #2's own.
 */
import { hex, type SyncFs } from "./fs";
import { SessionClient, RemoteExecError } from "./session";
import {
  DEFAULT_LIMITS,
  pull,
  push,
  skippedReport,
  type SyncLimits,
  type SyncReport,
} from "./sync";
import { startProcess, type ExecTarget } from "./target";
import { normalizeGlobs, relativeCwd } from "./walk";

export const DEFAULT_AGENT_PATH = "/usr/local/bin/remote-exec";

export interface RemoteExecConfig {
  target: ExecTarget;
  fs: SyncFs;
  /** The workspace directory that maps to `containerRoot`. */
  workspaceRoot?: string;
  containerRoot?: string;
  agentPath?: string;
  limits?: Partial<SyncLimits>;
  /** Session id; defaults to a random one. */
  id?: string;
}

export interface RemoteExecOptions {
  push?: string[];
  pull?: string[];
  user?: string;
  /** Who pushed files belong to, `"uid:gid"`, or `""` to leave them root's. Defaults to `user`. */
  pushOwner?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array> | "pipe";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
  signal?: AbortSignal;
  lockTimeoutMs?: number;
}

export interface RemoteProcess {
  readonly id: string;
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
  /** Resolves after the command exits and pull has finished. */
  readonly exitCode: Promise<number>;
  readonly pushed: SyncReport;
  readonly pulled: Promise<SyncReport>;
  /** Signals every process the command started. */
  kill(signal?: number): void;
  /** What an aborted `signal` does: SIGKILL everything the command started, and skip pull. */
  abort(): void;
}

export class ExecSyncError extends Error {
  override name = "ExecSyncError";
  constructor(
    message: string,
    readonly exitCode: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

function mapCwd(cwd: string | undefined, workspaceRoot: string, containerRoot: string): string {
  const rel = relativeCwd(cwd, workspaceRoot);
  if (rel === undefined) {
    // An absolute path elsewhere in the container is the caller's to choose.
    if (cwd?.startsWith("/")) return cwd;
    throw new TypeError(`exec: cwd ${JSON.stringify(cwd)} reaches outside ${workspaceRoot}`);
  }
  return rel ? `${containerRoot.replace(/\/$/, "")}/${rel}` : containerRoot;
}

function checkUser(user: string | undefined): string {
  if (user === undefined || user === "") return "";
  if (!/^\d+:\d+$/.test(user))
    throw new TypeError(`exec: user must be numeric "uid:gid", got ${JSON.stringify(user)}`);
  return user;
}

export async function remoteExec(
  config: RemoteExecConfig,
  argv: string[],
  options: RemoteExecOptions = {},
): Promise<RemoteProcess> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw new TypeError("exec: argv must be a non-empty array of strings");
  }
  if (options.signal?.aborted) throw abortError();
  const workspaceRoot = config.workspaceRoot ?? "/workspace";
  const containerRoot = config.containerRoot ?? "/workspace";
  const agentPath = config.agentPath ?? DEFAULT_AGENT_PATH;
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const pushGlobs = normalizeGlobs(options.push, workspaceRoot, options.cwd);
  const pullGlobs = normalizeGlobs(options.pull, workspaceRoot, options.cwd);
  const cwd = mapCwd(options.cwd, workspaceRoot, containerRoot);
  const user = checkUser(options.user);
  const pushOwner = options.pushOwner === undefined ? user : checkUser(options.pushOwner);
  const id = config.id ?? `x${hex(crypto.getRandomValues(new Uint8Array(12)))}`;

  const session = await SessionClient.start(config.target, agentPath, id);
  const signal = options.signal;
  let started = false;
  let aborted = false;
  let exited = false;
  const signalCommand = (sig: number) => {
    if (exited) return;
    void session.request({ type: "signal", signal: sig }, "signaled").catch(() => undefined);
  };
  // One listener for the whole call. Before the command starts (waiting for the lock, pushing,
  // preparing), an abort ends the session, which fails the step in progress and never starts the
  // command; after, it SIGKILLs everything the command started and skips pull.
  const onAbort = () => {
    aborted = true;
    if (started) signalCommand(9);
    else session.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const begun = await session.request(
      {
        type: "begin",
        id,
        root: containerRoot,
        lock: pushGlobs.length + pullGlobs.length > 0,
        lockTimeoutMs: options.lockTimeoutMs ?? 60_000,
      },
      "begun",
    );
    const pushed = pushGlobs.length
      ? await push(
          session,
          config.fs,
          workspaceRoot,
          containerRoot,
          pushGlobs,
          pushOwner,
          limits,
          begun.lockWaitMs,
        )
      : { report: skippedReport(begun.lockWaitMs), hashes: new Map<string, Uint8Array>() };
    const { token } = await session.request(
      {
        type: "prepare",
        spec: {
          argv,
          cwd,
          env: options.env ?? {},
          user,
        },
        pull: { root: containerRoot, globs: pullGlobs },
      },
      "prepared",
    );
    const run = await startProcess(
      config.target,
      [agentPath, "run", "--session", id, "--token", hex(token)],
      {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        stdout: options.stdout ?? "pipe",
        stderr: options.stderr ?? "pipe",
      },
    );
    const { pid } = await session.request({ type: "awaitStart" }, "started");
    // An abort that landed while the session answered has ended it already.
    if (aborted) throw abortError();
    started = true;

    let resolvePulled!: (r: SyncReport) => void;
    let rejectPulled!: (e: unknown) => void;
    const pulled = new Promise<SyncReport>((resolve, reject) => {
      resolvePulled = resolve;
      rejectPulled = reject;
    });
    pulled.catch(() => undefined);

    const exitCode = (async () => {
      let code: number;
      try {
        code = await run.exitCode;
      } catch (error) {
        // Without the abort, the remote-exec session keeps its root's lock until it times out.
        session.abort();
        rejectPulled(error);
        throw error;
      } finally {
        exited = true;
        signal?.removeEventListener("abort", onAbort);
      }
      try {
        if (aborted || pullGlobs.length === 0) {
          resolvePulled(skippedReport(begun.lockWaitMs));
          await session.close().catch(() => session.abort());
          return code;
        }
        const report = await pull(
          session,
          config.fs,
          workspaceRoot,
          pushed.hashes,
          limits,
          begun.lockWaitMs,
        );
        resolvePulled(report);
        await session.close().catch(() => session.abort());
        return code;
      } catch (error) {
        session.abort();
        rejectPulled(error);
        throw new ExecSyncError(
          `exec: the command exited ${code}, but pull failed: ${error instanceof Error ? error.message : String(error)}`,
          code,
          {
            cause: error,
          },
        );
      }
    })();

    return {
      id,
      pid,
      stdin: run.stdin,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode,
      pushed: pushed.report,
      pulled,
      abort: onAbort,
      kill: (signal = 15) => {
        if (!Number.isInteger(signal) || signal < 1 || signal > 64)
          throw new RangeError("exec: signal must be 1 to 64");
        signalCommand(signal);
      },
    };
  } catch (error) {
    if (!started) {
      session.abort();
      signal?.removeEventListener("abort", onAbort);
      // Whatever the step in progress failed with, the reason is the abort.
      if (aborted) throw abortError();
    }
    if (error instanceof RemoteExecError && error.code === "spawn") {
      // Match the platform: a command that can't start rejects exec().
      throw new RemoteExecError("spawn", `exec: ${error.message}`, error.errno);
    }
    throw error;
  }
}
