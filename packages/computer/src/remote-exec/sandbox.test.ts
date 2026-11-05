/**
 * The container-backed target, in workerd (it needs cloudflare:workers): ProcessHandle's mapping of
 * the platform's process, and ContainerExec (behind ExecSandbox) starting its container on demand.
 */
import { describe, expect, it } from "vitest";
import { CA_ENV, TRUST_CA_SCRIPT } from "./egress";
import { ContainerExec, ProcessHandle, withEgress } from "./sandbox";

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
