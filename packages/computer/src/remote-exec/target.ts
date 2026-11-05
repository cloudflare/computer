import type { WorkspaceModuleCallContext } from "../runtime/types";

/**
 * The target contract: what a Durable Object must expose for remote exec. It's
 * `ctx.container.exec()` minus what can't cross Workers RPC: no `AbortSignal` (use `kill()`), and
 * the process comes back as an `RpcTarget`.
 */
export interface ExecTarget {
  exec(cmd: string[], options?: ExecTargetOptions): Promise<ExecTargetProcess>;
}

export interface ExecTargetOptions {
  stdin?: ReadableStream<Uint8Array> | "pipe";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
  cwd?: string;
  env?: Record<string, string>;
  /** "uid:gid", numeric. */
  user?: string;
}

export interface ExecTargetProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | undefined | null;
  readonly stdout: ReadableStream<Uint8Array> | undefined | null;
  readonly stderr: ReadableStream<Uint8Array> | undefined | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
  /**
   * All three streams in one call. Over Workers RPC an `RpcTarget`'s getter can be serialized more
   * than once, which fails for a JS-created stream ("locked to a writer"); a method's result is
   * serialized once. `ProcessHandle` implements it, and `startProcess()` prefers it.
   */
  streams?(): ProcessStreams | Promise<ProcessStreams>;
}

export interface ProcessStreams {
  stdin: WritableStream<Uint8Array> | null | undefined;
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
}

/** A process with its fields resolved: plain values and streams, usable locally. */
export interface ResolvedProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

/**
 * Start a process on a target and resolve its fields. Over Workers RPC the process is a stub:
 * every property is a promise (`stub.stdout.getReader()` would be a remote call), so await each
 * one. A local object resolves the same way.
 */
export async function startProcess(
  target: ExecTarget,
  cmd: string[],
  options?: ExecTargetOptions,
): Promise<ResolvedProcess> {
  const p = await target.exec(cmd, options);
  // A stub answers to any name, so `streams` looks like a function on every stub; plain objects
  // (a local process, the platform's ExecProcess) have properties instead.
  const streams: ProcessStreams =
    typeof p.streams === "function"
      ? await p.streams()
      : await Promise.all([
          Promise.resolve(p.stdin),
          Promise.resolve(p.stdout),
          Promise.resolve(p.stderr),
        ]).then(([stdin, stdout, stderr]) => ({ stdin, stdout, stderr }));
  const pid = await Promise.resolve(p.pid);
  const { stdin, stdout, stderr } = streams;
  const exitCode = Promise.resolve(p.exitCode);
  exitCode.catch(() => undefined);
  return {
    pid,
    stdin: stdin ?? undefined,
    stdout: stdout ?? undefined,
    stderr: stderr ?? undefined,
    exitCode,
    kill: (signal?: number) => {
      void Promise.resolve(p.kill(signal)).catch(() => undefined);
    },
  };
}

/**
 * Where the host module gets its target from; binding, naming and authorization are the host's.
 * Given the host call's context, so a host can pick the target per run.
 */
export type ResolveTarget = (
  context: WorkspaceModuleCallContext,
) => ExecTarget | Promise<ExecTarget>;
