/**
 * The container-backed target, in workerd (it needs cloudflare:workers): ProcessHandle's mapping of
 * the platform's process, and ContainerExec (behind ExecSandbox) starting its container on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CA_ENV, TRUST_CA_SCRIPT } from "./egress";
import {
  ContainerExec,
  DEFAULT_SNAPSHOT_DEBOUNCE_MS,
  ExecSandbox,
  ProcessHandle,
  withEgress,
  type PlatformContainer,
} from "./sandbox";

interface FakeProcess {
  pid: number;
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  kill(signal?: number): void;
}

function fakeProcess(
  overrides: Partial<FakeProcess> = {},
): FakeProcess & { killed: (number | undefined)[] } {
  const killed: (number | undefined)[] = [];
  return {
    pid: 12,
    stdin: null,
    stdout: new Blob(["out"]).stream(),
    stderr: null,
    exitCode: Promise.resolve(0),
    kill: (s) => killed.push(s),
    killed,
    ...overrides,
  };
}

describe("ProcessHandle", () => {
  it("passes the process through, with missing streams as null (undefined breaks RPC)", async () => {
    const p = fakeProcess({ exitCode: Promise.resolve(3) });
    const handle = new ProcessHandle(p);
    expect(handle.pid).toBe(12);
    expect(handle.stdin).toBeNull();
    expect(handle.stderr).toBeNull();
    expect(await new Response(handle.stdout).text()).toBe("out");
    expect(await handle.exitCode).toBe(3);
    handle.kill(9);
    expect(p.killed).toEqual([9]);
    const undefinedStreams = new ProcessHandle({
      ...fakeProcess(),
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
    } as never);
    expect([undefinedStreams.stdin, undefinedStreams.stdout, undefinedStreams.stderr]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

function fakeContainer(running: boolean) {
  const log: string[] = [];
  const container = {
    running,
    start: (options?: Record<string, unknown>) => {
      log.push(`start ${JSON.stringify(options)}`);
      container.running = true;
    },
    monitor: () => new Promise<void>(() => undefined),
    setInactivityTimeout: async (ms: number) => {
      log.push(`timeout ${ms}`);
    },
    exec: async (cmd: string[], options?: unknown) => {
      log.push(`exec ${cmd.join(" ")} ${JSON.stringify(options)}`);
      return fakeProcess();
    },
  };
  return { container, log };
}

/** A container with outbound interception, whose commands echo; `trust` answers the CA script. */
function interceptingContainer(
  trust: { exitCode: number; stderr: string } = { exitCode: 0, stderr: "" },
) {
  const { container, log } = fakeContainer(false);
  const intercepting = Object.assign(container, {
    interceptAllOutboundHttp: async (binding: Fetcher) => {
      log.push(`intercept http ${(binding as unknown as { name: string }).name}`);
    },
    interceptOutboundHttps: async (addr: string, binding: Fetcher) => {
      log.push(`intercept https ${addr} ${(binding as unknown as { name: string }).name}`);
    },
    exec: async (cmd: string[], options?: unknown) => {
      const script = cmd[2] === TRUST_CA_SCRIPT;
      log.push(script ? `trust ${JSON.stringify(options)}` : `exec ${cmd.join(" ")}`);
      return script
        ? fakeProcess({
            exitCode: Promise.resolve(trust.exitCode),
            stderr: new Blob([trust.stderr]).stream(),
          })
        : fakeProcess();
    },
  });
  return { container: intercepting, log };
}

interface Egress {
  name: string;
}

const EGRESS: Egress = { name: "the caller's egress" };

function egressing(container: unknown, startOptions: Record<string, unknown> = {}) {
  return new ContainerExec<Egress>({
    container: () => container as never,
    startOptions: () => startOptions,
    outbound: (egress) =>
      egress === undefined ? undefined : ({ name: `outbound for ${egress.name}` } as never),
  });
}

function hooked(
  container: unknown,
  hooks: { onIdle?: () => void; onStopped?: (e: unknown) => void } = {},
) {
  return new ContainerExec({
    container: () => container as never,
    startOptions: () => ({ enableInternet: false }),
    inactivityTimeoutMs: () => 1234,
    ...hooks,
  });
}

function sandbox(container: unknown): ContainerExec {
  return new ContainerExec({
    container: () => container as never,
    startOptions: () => ({ enableInternet: false }),
  });
}

describe("ContainerExec (what ExecSandbox delegates to)", () => {
  it("starts a stopped container once, with the subclass's options and an inactivity timeout", async () => {
    const { container, log } = fakeContainer(false);
    const s = sandbox(container);
    const handle = await s.exec(["ls"], { stdout: "pipe" });
    await s.exec(["pwd"]);
    expect(handle).toBeInstanceOf(ProcessHandle);
    expect(log).toEqual([
      'start {"enableInternet":false}',
      "timeout 600000",
      'exec ls {"stdout":"pipe","user":"0:0"}',
      'exec pwd {"user":"0:0"}',
    ]);
  });

  it("runs as root unless the sandbox or the call names another user", async () => {
    const { container, log } = fakeContainer(true);
    await sandbox(container).exec(["id"]);
    await sandbox(container).exec(["id"], { user: "1000:1000" });
    await new ContainerExec({
      container: () => container as never,
      startOptions: () => undefined,
      user: "1000:1000",
    }).exec(["id"]);
    expect(log).toEqual([
      'exec id {"user":"0:0"}',
      'exec id {"user":"1000:1000"}',
      'exec id {"user":"1000:1000"}',
    ]);
  });

  it("uses a running container as it is", async () => {
    const { container, log } = fakeContainer(true);
    await sandbox(container).exec(["ls"]);
    expect(log).toEqual(['exec ls {"user":"0:0"}']);
  });

  it("explains a missing container binding", async () => {
    await expect(sandbox(undefined).exec(["ls"])).rejects.toThrow(/no container binding/);
  });

  it("streams() returns all three streams in one result", async () => {
    const p = fakeProcess();
    const streams = new ProcessHandle(p).streams();
    expect(streams.stdin).toBeNull();
    expect(await new Response(streams.stdout).text()).toBe("out");
  });

  it("calls onIdle when the last running process exits, and uses the inactivity timeout given", async () => {
    const { container, log } = fakeContainer(false);
    let resolveA!: (n: number) => void;
    let resolveB!: (n: number) => void;
    const exits = [
      new Promise<number>((r) => (resolveA = r)),
      new Promise<number>((r) => (resolveB = r)),
    ];
    let i = 0;
    container.exec = async () => fakeProcess({ exitCode: exits[i++] ?? Promise.resolve(0) });
    let idle = 0;
    const target = hooked(container, { onIdle: () => idle++ });
    await target.exec(["a"]);
    await target.exec(["b"]);
    expect(target.running).toBe(2);
    resolveA(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(0);
    resolveB(1);
    await new Promise((r) => setTimeout(r, 0));
    expect([idle, target.running]).toEqual([1, 0]);
    expect(log).toContain("timeout 1234");
  });

  it("reports the container stopping, cleanly or not", async () => {
    const seen: unknown[] = [];
    const clean = fakeContainer(false);
    clean.container.monitor = () => Promise.resolve();
    await hooked(clean.container, { onStopped: (e) => seen.push(e ?? "clean") }).exec(["x"]);
    const failed = fakeContainer(false);
    failed.container.monitor = () => Promise.reject(new Error("snapshot expired"));
    await hooked(failed.container, { onStopped: (e) => seen.push(String(e)) }).exec(["x"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["clean", "Error: snapshot expired"]);
  });

  it("tolerates a concurrent start, and destroy stops a running container only", async () => {
    const { container } = fakeContainer(false);
    container.start = () => {
      throw new Error("Container is already running");
    };
    await expect(hooked(container).exec(["x"])).resolves.toBeInstanceOf(ProcessHandle);
    let destroyed = 0;
    const running = { ...fakeContainer(true).container, destroy: async () => void destroyed++ };
    await hooked(running).destroy();
    const stopped = { ...fakeContainer(false).container, destroy: async () => void destroyed++ };
    await hooked(stopped).destroy();
    expect(destroyed).toBe(1);
  });

  it("given an egress, routes a container it starts through it and trusts its CA before any command", async () => {
    const { container, log } = interceptingContainer();
    const target = egressing(container, { image: "base" });
    await Promise.all([
      target.exec(["a"], undefined, EGRESS),
      target.exec(["b"], undefined, EGRESS),
    ]);
    await target.exec(["c"], undefined, EGRESS);
    expect(log).toEqual([
      `start ${JSON.stringify({ enableInternet: false, image: "base", env: CA_ENV })}`,
      "timeout 600000",
      "intercept http outbound for the caller's egress",
      "intercept https * outbound for the caller's egress",
      'trust {"user":"0:0","stdout":"ignore","stderr":"pipe"}',
      "exec a",
      "exec b",
      "exec c",
    ]);
  });

  it("lets the start options turn the internet on, and keeps their env under the CA's", async () => {
    const { container, log } = interceptingContainer();
    const env = { A: "1", SSL_CERT_FILE: "/image/bundle.pem" };
    await egressing(container, { enableInternet: true, env }).exec(["a"], undefined, EGRESS);
    expect(log[0]).toBe(
      `start ${JSON.stringify({ enableInternet: true, env: { ...env, ...CA_ENV } })}`,
    );
  });

  it("fails the command when the CA can't be trusted, or the container can't intercept", async () => {
    const failing = interceptingContainer({ exitCode: 1, stderr: "no CA" });
    await expect(egressing(failing.container).exec(["a"], undefined, EGRESS)).rejects.toThrow(
      "the container can't trust its egress CA (exit 1): no CA",
    );
    expect(failing.log).not.toContain("exec a");
    const { container } = fakeContainer(false);
    await expect(egressing(container).exec(["a"], undefined, EGRESS)).rejects.toThrow(
      /no outbound interception/,
    );
  });

  it("routes a running container again before the next command, after routing failed", async () => {
    const trust = { exitCode: 1, stderr: "no CA yet" };
    const { container, log } = interceptingContainer(trust);
    const target = egressing(container);
    await expect(target.exec(["a"], undefined, EGRESS)).rejects.toThrow(/no CA yet/);
    expect(log).toContain("timeout 600000");
    trust.exitCode = 0;
    await target.exec(["b"], undefined, EGRESS);
    await target.exec(["c"], undefined, EGRESS);
    expect(log.filter((line) => !line.startsWith("start") && !line.startsWith("timeout"))).toEqual([
      "intercept http outbound for the caller's egress",
      "intercept https * outbound for the caller's egress",
      'trust {"user":"0:0","stdout":"ignore","stderr":"pipe"}',
      "intercept http outbound for the caller's egress",
      "intercept https * outbound for the caller's egress",
      'trust {"user":"0:0","stdout":"ignore","stderr":"pipe"}',
      "exec b",
      "exec c",
    ]);
  });

  it("routes a container that was running before this object started, once", async () => {
    const { container, log } = interceptingContainer();
    container.running = true;
    const target = egressing(container);
    await target.exec(["a"], undefined, EGRESS);
    await target.exec(["b"], undefined, EGRESS);
    expect(log).toEqual([
      "intercept http outbound for the caller's egress",
      "intercept https * outbound for the caller's egress",
      'trust {"user":"0:0","stdout":"ignore","stderr":"pipe"}',
      "exec a",
      "exec b",
    ]);
  });

  it("without an egress, starts the container as the options say", async () => {
    const { container, log } = interceptingContainer();
    await egressing(container, { enableInternet: true }).exec(["a"]);
    expect(log).toEqual(['start {"enableInternet":true}', "timeout 600000", "exec a"]);
  });

  it("routes every container it starts through an outbound that needs no egress", async () => {
    const { container, log } = interceptingContainer();
    const target = new ContainerExec({
      container: () => container as never,
      startOptions: () => undefined,
      outbound: () => ({ name: "a fixed outbound" }) as never,
    });
    await target.exec(["a"]);
    expect(log).toEqual([
      `start ${JSON.stringify({ enableInternet: false, env: CA_ENV })}`,
      "timeout 600000",
      "intercept http a fixed outbound",
      "intercept https * a fixed outbound",
      'trust {"user":"0:0","stdout":"ignore","stderr":"pipe"}',
      "exec a",
    ]);
  });
});

/**
 * A running container whose exec() fails during a snapshot, like the platform's. Each command's
 * exit is in `exit(name)`; `snapshots` resolves or rejects the one in progress.
 */
function snapshottingContainer() {
  const log: string[] = [];
  const exits = new Map<string, (code: number) => void>();
  const snapshots: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let inProgress = false;
  const container = {
    running: true,
    start: () => undefined,
    monitor: () => new Promise<void>(() => undefined),
    exec: async (cmd: string[]) => {
      if (inProgress) throw new Error("cannot exec: a snapshot is in progress");
      const name = cmd.join(" ");
      log.push(`exec ${name}`);
      return fakeProcess({ exitCode: new Promise<number>((r) => exits.set(name, r)) });
    },
  };
  const take = (running: unknown) => {
    expect(running).toBe(container);
    log.push("snapshot");
    inProgress = true;
    return new Promise<void>((resolve, reject) => {
      snapshots.push({
        resolve: () => {
          inProgress = false;
          log.push("snapshot done");
          resolve();
        },
        reject: (e) => {
          inProgress = false;
          log.push("snapshot failed");
          reject(e);
        },
      });
    });
  };
  const exit = (name: string, code = 0) => {
    const resolve = exits.get(name);
    if (resolve === undefined) throw new Error(`no command ${name} to exit`);
    resolve(code);
  };
  const current = () => {
    const snapshot = snapshots.shift();
    if (snapshot === undefined) throw new Error("no snapshot in progress");
    return snapshot;
  };
  const finishSnapshot = () => current().resolve();
  const failSnapshot = (error: Error) => current().reject(error);
  return { container, log, take, exit, finishSnapshot, failSnapshot };
}

/** A target that snapshots with `c`, after `debounceMs`, or after the default given "default". */
function snapshotted(
  c: ReturnType<typeof snapshottingContainer>,
  debounceMs: number | "default" = 1000,
) {
  return new ContainerExec({
    container: () => c.container as never,
    startOptions: () => undefined,
    snapshot: c.take,
    snapshotDebounceMs: debounceMs === "default" ? undefined : () => debounceMs,
  });
}

describe("ContainerExec snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("snapshots once the container has been idle for the debounce, and only after commands ran", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual([]);
    await target.exec(["a"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual(["exec a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(999);
    expect(c.log).toEqual(["exec a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.log).toEqual(["exec a", "snapshot"]);
    expect(target.snapshotting).toBe(true);
    c.finishSnapshot();
    await target.settled();
    expect(target.snapshotting).toBe(false);
    // Nothing ran since: no second snapshot.
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot done"]);
  });

  it("defaults to a 10 second debounce", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c, "default");
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(DEFAULT_SNAPSHOT_DEBOUNCE_MS - 1);
    expect(c.log).toEqual(["exec a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.log).toEqual(["exec a", "snapshot"]);
  });

  it("restarts the debounce when a command arrives, so gaps between commands don't snapshot", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(900);
    await target.exec(["b"]);
    c.exit("b");
    await vi.advanceTimersByTimeAsync(900);
    expect(c.log).toEqual(["exec a", "exec b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.log).toEqual(["exec a", "exec b", "snapshot"]);
  });

  it("doesn't snapshot while a command is running or on its way in", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    await target.exec(["long"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual(["exec a", "exec long"]);
    // A command whose platform exec() is still pending holds the snapshot off too.
    let enter!: () => void;
    const exec = c.container.exec;
    c.container.exec = async (cmd) => {
      await new Promise<void>((r) => (enter = r));
      return exec(cmd);
    };
    const slow = target.exec(["slow"]);
    c.exit("long");
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual(["exec a", "exec long"]);
    enter();
    await slow;
    c.exit("slow");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.log).toEqual(["exec a", "exec long", "exec slow", "snapshot"]);
  });

  it("queues commands that arrive during a snapshot and runs them in order once it's done", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(1000);
    const started: string[] = [];
    const queued = ["b", "c", "d"].map((name) =>
      target.exec([name]).then((handle) => {
        started.push(name);
        return handle;
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toEqual([]);
    expect(c.log).toEqual(["exec a", "snapshot"]);
    c.finishSnapshot();
    const handles = await Promise.all(queued);
    expect(handles.every((h) => h instanceof ProcessHandle)).toBe(true);
    expect(started).toEqual(["b", "c", "d"]);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot done", "exec b", "exec c", "exec d"]);
    // And they make the container dirty again: the next idle snapshots.
    for (const name of ["b", "c", "d"]) c.exit(name);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.log.at(-1)).toBe("snapshot");
  });

  it("releases queued commands when the snapshot fails, and tries again at the next idle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(1000);
    const queued = target.exec(["b"]);
    c.failSnapshot(new Error("disk full"));
    await expect(queued).resolves.toBeInstanceOf(ProcessHandle);
    expect(error).toHaveBeenCalledWith("container snapshot failed", "Error: disk full");
    c.exit("b");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot failed", "exec b", "snapshot"]);
  });

  it("retries a failed snapshot at the next idle even when no command ran during it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(1000);
    c.failSnapshot(new Error("disk full"));
    await target.settled();
    // No loop on its own.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot failed"]);
    // A command that fails to start still lets the pending retry be scheduled.
    c.container.exec = async () => {
      throw new Error("no such file");
    };
    await expect(target.exec(["missing"])).rejects.toThrow("no such file");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot failed", "snapshot"]);
  });

  it("skips the snapshot when the container stopped, or when there's no snapshot hook", async () => {
    const c = snapshottingContainer();
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    c.container.running = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.log).toEqual(["exec a"]);
    const plain = snapshottingContainer();
    const untouched = new ContainerExec({
      container: () => plain.container as never,
      startOptions: () => undefined,
      snapshotDebounceMs: () => 1000,
    });
    await untouched.exec(["a"]);
    plain.exit("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(plain.log).toEqual(["exec a"]);
  });

  it("ExecSandbox snapshots through a subclass's snapshot() after its debounce, and not without one", async () => {
    const c = snapshottingContainer();
    const ctx = { container: c.container, blockConcurrencyWhile: async (f: () => unknown) => f() };
    class Snapshotting extends ExecSandbox {
      protected startOptions() {
        return undefined;
      }
      protected override async snapshot(container: PlatformContainer) {
        await c.take(container);
      }
      protected override snapshotDebounceMs() {
        return 50;
      }
      get isSnapshotting() {
        return this.snapshotting;
      }
    }
    const sandbox = new Snapshotting(ctx as never, {});
    await sandbox.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(50);
    expect(c.log).toEqual(["exec a", "snapshot"]);
    expect(sandbox.isSnapshotting).toBe(true);
    const queued = sandbox.exec(["b"]);
    c.finishSnapshot();
    await queued;
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot done", "exec b"]);

    const plain = snapshottingContainer();
    class Plain extends ExecSandbox {
      protected startOptions() {
        return undefined;
      }
    }
    const unsnapshotted = new Plain({ ...ctx, container: plain.container } as never, {});
    await unsnapshotted.exec(["a"]);
    plain.exit("a");
    await vi.advanceTimersByTimeAsync(DEFAULT_SNAPSHOT_DEBOUNCE_MS);
    expect(plain.log).toEqual(["exec a"]);
  });

  it("destroy waits for a snapshot in progress and drops a pending one", async () => {
    const c = snapshottingContainer();
    let destroyed = 0;
    Object.assign(c.container, { destroy: async () => void destroyed++ });
    const target = snapshotted(c);
    await target.exec(["a"]);
    c.exit("a");
    await vi.advanceTimersByTimeAsync(1000);
    const destroying = target.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(destroyed).toBe(0);
    c.finishSnapshot();
    await destroying;
    expect(destroyed).toBe(1);
    // Pending, not started: destroy cancels it.
    await target.exec(["b"]);
    c.exit("b");
    await target.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.log).toEqual(["exec a", "snapshot", "snapshot done", "exec b"]);
  });
});

describe("withEgress", () => {
  it("passes the egress with every command", async () => {
    const calls: unknown[] = [];
    const target = withEgress<Egress>(
      {
        exec: async (cmd, options, egress) => {
          calls.push([cmd, options, egress]);
          return new ProcessHandle(fakeProcess());
        },
      },
      EGRESS,
    );
    await target.exec(["ls"], { cwd: "/" });
    expect(calls).toEqual([[["ls"], { cwd: "/" }, EGRESS]]);
  });
});
