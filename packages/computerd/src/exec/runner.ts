// Process supervisor.
//
// Spawns commands, fans each chunk into (a) the live ReadableStream
// the first subscriber consumes via capnweb, and (b) the DB-backed
// EventLog used by getExec({ after }) reattach.
//
// Backpressure: events go straight into the stream's internal
// queue via controller.enqueue. When capnweb's flow controller
// stops pulling, desiredSize drops; the runner pauses the child's
// stdout/stderr Readables; the kernel pipe fills; the child blocks
// on write. End-to-end pull backpressure with no in-process buffer
// larger than the kernel pipe.
//
// The EventLog is a side-channel for reattach. Every chunk is also
// written there; the live stream never reads from it (except to
// seed a replay window when a caller reattaches via get(id, {after})).

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { type Database, stat } from "@cloudflare/dofs";

import { createLog, type EventLog, openLog } from "./log.js";
import { clearExecState, initializeExecSchema } from "./schema.js";
import { ExecError, type ExecEvent, type ExecOptions, type RunnerOptions } from "./types.js";

interface ExecRecord {
  id: string;
  child: ChildProcess;
  log: EventLog;
  startedAt: number;
  lastOutputAt?: number;
  exitedAt?: number;
  live: boolean;
  subscriber?: LiveSubscriber;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
}

interface LiveSubscriber {
  enqueue: (event: ExecEvent) => void;
  close: () => void;
  error: (err: unknown) => void;
  paused: boolean;
  pause: () => void;
  resume: () => void;
}

export interface ExecHandle {
  id: string;
  events: ReadableStream<ExecEvent>;
}

const DEFAULTS = {
  logMaxBytes: 16 * 1024 * 1024,
  retentionMs: 5 * 60 * 1000,
  sweepIntervalMs: 30 * 1000,
  defaultTimeoutMs: 320_000,
  // After SIGTERM, give the child this long to exit on its own
  // before sending SIGKILL.
  killGraceMs: 5_000,
} as const;

export interface RunnerInit extends RunnerOptions {
  db: Database;
  // Clear any orphaned exec rows from a previous computerd process.
  // Defaults true; tests can opt out.
  resetSchema?: boolean;
}

export class Runner {
  private readonly db: Database;
  private readonly opts: {
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    logMaxBytes: number;
    retentionMs: number;
    sweepIntervalMs: number;
    defaultTimeoutMs: number;
    heartbeatIntervalMs: number;
    now: () => number;
  };
  private readonly records = new Map<string, ExecRecord>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(init: RunnerInit) {
    this.db = init.db;
    this.opts = {
      cwd: init.cwd,
      env: init.env,
      logMaxBytes: init.logMaxBytes ?? DEFAULTS.logMaxBytes,
      retentionMs: init.retentionMs ?? DEFAULTS.retentionMs,
      sweepIntervalMs: init.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs,
      defaultTimeoutMs: init.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
      heartbeatIntervalMs: init.heartbeatIntervalMs ?? 0,
      now: init.now ?? Date.now,
    };
    initializeExecSchema(this.db);
    if (init.resetSchema !== false) clearExecState(this.db);
  }

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    if (this.disposed) throw new Error("runner disposed");
    const id = options.id ?? randomUUID();
    const existing = this.records.get(id);
    if (existing?.live) {
      throw new ExecError("EEXEC_BUSY", `exec id ${id} is already running`);
    }
    if (existing !== undefined) this.disposeRecord(existing);

    const cwd = options.cwd ?? this.opts.cwd;
    const env = { ...process.env, ...this.opts.env, ...options.env };
    // Pre-flight the cwd via dofs's stat which walks vfs_nodes /
    // vfs_dirents in SQLite directly — no node:fs.statSync, no
    // FUSE callback. Preserves the historical ENOENT-cwd error
    // shape callers see when the path doesn't exist, without
    // taking a route that could deadlock against computerd's own FUSE
    // server.
    if (cwd !== undefined) {
      try {
        stat(this.db, cwd);
      } catch (err) {
        return this.spawnFailed(id, err);
      }
    }
    // Don't pass cwd to spawn. libuv's uv_spawn does fork +
    // chdir + execve in the child while the parent blocks on a
    // status pipe. If cwd lives inside computerd's own FUSE mount, the
    // child's chdir issues a FUSE LOOKUP that computerd can't service
    // (its event loop is stuck in uv_spawn), and the whole
    // process deadlocks. Have /bin/sh do the chdir instead: by
    // the time the shell runs its `cd`, computerd's event loop is back
    // and can answer the FUSE callback normally.
    //
    // No `exec` prefix on the user command: the user's argument
    // may be a compound expression (`echo a && exit 3`), and
    // `exec` only binds to the next simple command, which would
    // cut off everything after the first `&&`. The shell stays
    // as the spawned process either way — the original code
    // (`spawn("/bin/sh", ["-c", command])`) was already a shell-
    // owned exec, so this is no change in process shape.
    const wrapped = cwd !== undefined ? `cd ${shellQuote(cwd)} && ${command}` : command;
    const child = spawn("/bin/sh", ["-c", wrapped], {
      env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.stdin !== undefined && child.stdin) {
      // Feed the caller's bytes then close so the child sees EOF.
      // Ignore write/EPIPE errors: a command that never reads stdin
      // (or exits first) must not fail the run.
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(options.stdin));
    }
    const log = createLog(this.db, id, {
      maxBytes: this.opts.logMaxBytes,
      now: this.opts.now,
    });
    const record: ExecRecord = {
      id,
      child,
      log,
      startedAt: this.opts.now(),
      live: true,
    };
    this.records.set(id, record);

    const onData = (name: "stdout" | "stderr") => (chunk: Buffer) => {
      const value = new Uint8Array(chunk);
      const seq = log.append(name, value);
      record.lastOutputAt = this.opts.now();
      record.subscriber?.enqueue({ id, seq, name, value });
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));

    if (this.opts.heartbeatIntervalMs > 0) {
      const scheduleHeartbeat = (): void => {
        record.heartbeatTimer = setTimeout(() => {
          if (!record.live) return;
          const now = this.opts.now();
          const elapsedMs = now - record.startedAt;
          const lastOutputMs =
            record.lastOutputAt !== undefined ? now - record.lastOutputAt : elapsedMs;
          const pid = child.pid ?? 0;
          const seq = log.allocSeq();
          record.subscriber?.enqueue({
            id,
            seq,
            name: "heartbeat",
            value: { pid, elapsedMs, lastOutputMs },
          });
          scheduleHeartbeat();
        }, this.opts.heartbeatIntervalMs);
        record.heartbeatTimer.unref?.();
      };
      scheduleHeartbeat();
    }

    const finalise = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!record.live) return;
      record.live = false;
      record.exitedAt = this.opts.now();
      if (record.timeoutTimer !== undefined) {
        clearTimeout(record.timeoutTimer);
        record.timeoutTimer = undefined;
      }
      if (record.killTimer !== undefined) {
        clearTimeout(record.killTimer);
        record.killTimer = undefined;
      }
      if (record.heartbeatTimer !== undefined) {
        clearTimeout(record.heartbeatTimer);
        record.heartbeatTimer = undefined;
      }
      const exitCode = mapExitCode(code, signal);
      let seq: number;
      try {
        seq = log.setExit(exitCode);
      } catch (err) {
        // The log row vanished (disposed mid-exit, schema reset, ...).
        // Surface the exit to the live subscriber anyway so its
        // stream closes, then propagate the storage failure as an
        // error on the same stream. Without this the subscriber
        // hangs forever waiting for an exit event that already
        // happened.
        record.subscriber?.error(err instanceof Error ? err : new Error(String(err)));
        record.subscriber = undefined;
        this.scheduleSweep();
        return;
      }
      record.subscriber?.enqueue({ id, seq, name: "exit", value: exitCode });
      record.subscriber?.close();
      record.subscriber = undefined;
      this.scheduleSweep();
    };
    child.once("exit", finalise);
    child.once("error", (err) => {
      if (!record.live) return;
      const value = new TextEncoder().encode(`spawn failed: ${err.message}\n`);
      const seq = log.append("stderr", value);
      record.subscriber?.enqueue({ id, seq, name: "stderr", value });
      finalise(-1, null);
    });

    const timeoutMs = options.timeoutMs ?? this.opts.defaultTimeoutMs;
    if (timeoutMs > 0) {
      record.timeoutTimer = setTimeout(() => {
        if (!record.live) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // Child already gone; finalise will sort it out.
        }
        record.killTimer = setTimeout(() => {
          if (!record.live) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, DEFAULTS.killGraceMs);
      }, timeoutMs);
    }

    this.scheduleSweep();
    return { id, events: this.makeLiveStream(record, -1) };
  }

  get(id: string, options: { after?: number | "tail" } = {}): ExecHandle {
    const after = options.after ?? 0;
    const record = this.records.get(id);
    if (record?.live) {
      // Live reattach: seed with whatever's already in the log
      // past `after`, then continue with live events.
      return { id, events: this.makeLiveStream(record, after === "tail" ? -1 : after) };
    }
    const log =
      record?.log ?? openLog(this.db, id, { maxBytes: this.opts.logMaxBytes, now: this.opts.now });
    if (log === undefined) {
      throw new ExecError("ENOENT", `no exec record for id ${id}`);
    }
    return { id, events: replayToStream(log, after) };
  }

  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): void {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new ExecError("ENOENT", `no exec record for id ${id}`);
    }
    if (!record.live) return;
    record.child.kill(signal);
  }

  dispose(id: string): void {
    const record = this.records.get(id);
    if (record !== undefined) {
      this.disposeRecord(record);
      return;
    }
    const log = openLog(this.db, id, {
      maxBytes: this.opts.logMaxBytes,
      now: this.opts.now,
    });
    log?.dispose();
  }

  disposeAll(): void {
    this.disposed = true;
    for (const record of [...this.records.values()]) {
      this.disposeRecord(record);
    }
    if (this.sweepTimer !== undefined) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  // Test seam: drive retention without waiting for the timer.
  sweep(): void {
    const cutoff = this.opts.now() - this.opts.retentionMs;
    for (const record of [...this.records.values()]) {
      if (record.live) continue;
      if ((record.exitedAt ?? 0) <= cutoff) this.disposeRecord(record);
    }
    // Also reap orphan rows whose in-memory record is gone.
    this.db.run(
      `DELETE FROM computerd_exec_log WHERE exec_id IN (
				SELECT exec_id FROM computerd_exec_meta
				WHERE exited_at IS NOT NULL AND exited_at <= ?
			)`,
      cutoff,
    );
    this.db.run(
      `DELETE FROM computerd_exec_meta
			   WHERE exited_at IS NOT NULL AND exited_at <= ?`,
      cutoff,
    );
  }

  // `replayAfter < 0` means "fresh subscription, no replay". Any
  // non-negative value seeds the stream with log rows seq > value
  // before live events start flowing.
  private makeLiveStream(record: ExecRecord, replayAfter: number): ReadableStream<ExecEvent> {
    if (record.subscriber !== undefined) {
      throw new ExecError("EEXEC_BUSY", `exec ${record.id} already has a live subscriber`);
    }
    let controller: ReadableStreamDefaultController<ExecEvent> | undefined;
    let closed = false;
    const sub: LiveSubscriber = {
      paused: false,
      enqueue: (event) => {
        if (closed) return;
        if (controller === undefined) return;
        try {
          controller.enqueue(event);
        } catch {
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0) sub.pause();
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (controller !== undefined) {
          try {
            controller.close();
          } catch {
            /* */
          }
        }
      },
      error: (err) => {
        closed = true;
        if (controller !== undefined) {
          try {
            controller.error(err);
          } catch {
            /* */
          }
        }
      },
      pause: () => {
        if (sub.paused) return;
        sub.paused = true;
        record.child.stdout?.pause();
        record.child.stderr?.pause();
      },
      resume: () => {
        if (!sub.paused) return;
        sub.paused = false;
        record.child.stdout?.resume();
        record.child.stderr?.resume();
      },
    };
    record.subscriber = sub;

    return new ReadableStream<ExecEvent>({
      start: (c) => {
        controller = c;
        if (replayAfter >= 0) {
          for (const ev of record.log.replay(replayAfter)) {
            c.enqueue(ev);
          }
        }
        if (!record.live) c.close();
      },
      pull: () => {
        // Consumer drained; resume the child if we paused.
        if (sub.paused) sub.resume();
      },
      cancel: () => {
        closed = true;
        if (record.subscriber === sub) record.subscriber = undefined;
        sub.resume();
      },
    });
  }

  private disposeRecord(record: ExecRecord): void {
    record.live = false;
    if (record.timeoutTimer !== undefined) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = undefined;
    }
    if (record.killTimer !== undefined) {
      clearTimeout(record.killTimer);
      record.killTimer = undefined;
    }
    if (record.heartbeatTimer !== undefined) {
      clearTimeout(record.heartbeatTimer);
      record.heartbeatTimer = undefined;
    }
    try {
      if (record.child.exitCode === null && record.child.signalCode === null) {
        record.child.kill("SIGKILL");
      }
    } catch {
      /* */
    }
    record.subscriber?.close();
    record.subscriber = undefined;
    record.log.dispose();
    this.records.delete(record.id);
  }

  // Synthesise the same stderr + exit + closed-stream shape that
  // `child.once("error", ...)` produces for a real spawn failure,
  // for cases where we know the spawn would fail (e.g. cwd doesn't
  // exist) and want to surface it via the same return path without
  // ever calling `spawn`. Keeps the externally observable error
  // contract identical regardless of whether the failure was
  // detected pre-spawn or as a libuv ECHILD/ENOENT/etc on the
  // child itself.
  private spawnFailed(id: string, err: unknown): ExecHandle {
    const message = err instanceof Error ? err.message : String(err);
    const log = createLog(this.db, id, {
      maxBytes: this.opts.logMaxBytes,
      now: this.opts.now,
    });
    const value = new TextEncoder().encode(`spawn failed: ${message}\n`);
    const stderrSeq = log.append("stderr", value);
    const exitSeq = log.setExit(-1);
    log.dispose();
    const events = new ReadableStream<ExecEvent>({
      start(controller) {
        controller.enqueue({ id, seq: stderrSeq, name: "stderr", value });
        controller.enqueue({ id, seq: exitSeq, name: "exit", value: -1 });
        controller.close();
      },
    });
    return { id, events };
  }

  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined) return;
    if (this.records.size === 0) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
      if (this.records.size > 0) this.scheduleSweep();
    }, this.opts.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }
}

// Quote a single argument for /bin/sh -c. Wraps in single quotes
// and escapes any embedded single quote as '\''. Used to thread
// the spawn cwd into `cd <path> && exec <command>` without giving
// the shell a chance to misparse paths with spaces or shell
// metacharacters.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function mapExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGHUP") return 129;
  return -1;
}

function replayToStream(log: EventLog, after: number | "tail"): ReadableStream<ExecEvent> {
  const iter = log.replay(after)[Symbol.iterator]();
  return new ReadableStream<ExecEvent>({
    pull(controller) {
      const next = iter.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
  });
}
