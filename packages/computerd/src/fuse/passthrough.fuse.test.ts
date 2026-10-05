// Kernel FUSE passthrough for local-only paths, against a real mount.
//
// The unit tests drive the backing-id table through a fake registrar.
// What they cannot show is the kernel's side: that a passthrough open
// really takes computerd out of the data path, and that concurrent
// opens of one file do not trip the EIO the kernel gives a second
// backing id for the same inode. This boots the linux-x64 binary in a
// privileged container, the same way runner.fuse.test.ts does, and
// counts the daemon's read and write callbacks with the op tracer.
//
// Skips without Docker or the binary. The passthrough cases also skip,
// rather than fail, when the host kernel does not offer passthrough
// (Linux before 6.9), since that is a property of the machine running
// the test.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");
const COMPUTERD_BINARY = join(REPO_ROOT, "artifacts/computerd/computerd-linux-x64");
const RUN_COMPUTERD_SCRIPT = join(REPO_ROOT, "packages/computer/test-harness/run-computerd.sh");
// Outside the mount on purpose: a process serving a FUSE mount that
// writes into that mount deadlocks on itself.
const TRACE_FILE = "/tmp/computerd-trace.json";

function available(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    accessSync(COMPUTERD_BINARY);
    return true;
  } catch {
    return false;
  }
}

const describeIfReal = available() ? describe : describe.skip;

interface FastPaths {
  passthrough: boolean;
  passthroughReason: string;
  passthroughOpens: number;
  passthroughFallbacks: number;
}

describeIfReal("FUSE passthrough under a real mount", () => {
  let cid: string | undefined;
  let url = "";
  let client: ReturnType<typeof createWorkspaceClient> | undefined;
  let kernelOffersPassthrough = false;

  beforeAll(async () => {
    const proc = spawn("bash", [RUN_COMPUTERD_SCRIPT], {
      env: {
        ...process.env,
        COMPUTERD_HARNESS_PORT: "0",
        MOUNT_IGNORE: "/node_modules",
        COMPUTERD_FUSE_TRACE: "summary",
        COMPUTERD_FUSE_TRACE_FILE: TRACE_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!proc.stdout || !proc.stderr) throw new Error("run-computerd.sh exposed no pipes");
    const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    await waitForExit(proc);
    if (proc.exitCode !== 0) throw new Error(`run-computerd.sh exited ${proc.exitCode}: ${stderr}`);
    url = stdout.trim();
    cid = stderr.match(/COMPUTERD_HARNESS_CID=([0-9a-f]+)/)?.[1];
    client = createWorkspaceClient({
      url: `${url.replace(/^http(s?):\/\//, "ws$1://")}/api`,
      WebSocketImpl: WebSocket,
    });
    // Before any open the reason says whether the kernel offered the
    // capability at all, or whether COMPUTERD_FUSE_PASSTHROUGH in the
    // caller's environment turned it off.
    kernelOffersPassthrough = !/kernel did not offer|turned off/.test(
      (await fastPaths()).passthroughReason,
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    if (cid) {
      try {
        execFileSync("docker", ["kill", cid], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  });

  async function run(source: string): Promise<{ stdout: string; code: number | undefined }> {
    if (client === undefined) throw new Error("computerd container did not start");
    const handle = await client.shell.exec({ source, cwd: "/workspace", timeoutMs: 20_000 });
    const reader = handle.events.getReader();
    let stdout = "";
    let code: number | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const event = value as { name: string; value?: unknown; code?: number };
        if (event.name === "stdout") stdout += new TextDecoder().decode(event.value as Uint8Array);
        if (event.name === "exit") code = event.code;
      }
    } finally {
      reader.releaseLock();
    }
    return { stdout, code };
  }

  async function fastPaths(): Promise<FastPaths> {
    const response = await fetch(`${url}/__computerd/info`);
    return ((await response.json()) as { ignore: { fastPaths: FastPaths } }).ignore.fastPaths;
  }

  /** Read and write callbacks the daemon has served so far. */
  async function dataOps(): Promise<{ read: number; write: number }> {
    // computerd is PID 1 in the container; SIGUSR2 writes the trace.
    const { stdout } = await run(`kill -USR2 1 && sleep 0.5 && cat ${TRACE_FILE}`);
    const trace = JSON.parse(stdout) as { ops: Array<{ op: string; count: number }> };
    const count = (op: string) => trace.ops.find((entry) => entry.op === op)?.count ?? 0;
    return { read: count("read"), write: count("write") };
  }

  test("the kernel serves local-only file data without the daemon", async (ctx) => {
    if (!kernelOffersPassthrough) ctx.skip();
    const before = await dataOps();
    const result = await run(
      [
        "mkdir -p node_modules/pkg",
        "dd if=/dev/urandom of=node_modules/pkg/blob bs=1M count=4 2>/dev/null",
        "cat node_modules/pkg/blob node_modules/pkg/blob | wc -c",
        "cmp node_modules/pkg/blob /tmp/workspace/node_modules/pkg/blob && echo same",
      ].join(" && "),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${8 * 1024 * 1024}\nsame\n`);

    // Through computerd this would be 8 writes and 16 or more reads at
    // the 512 KiB request size. Passthrough makes it none.
    expect(await dataOps()).toEqual(before);

    const reported = await fastPaths();
    expect(reported.passthrough).toBe(true);
    expect(reported.passthroughOpens).toBeGreaterThan(0);
    expect(reported.passthroughFallbacks).toBe(0);
  }, 60_000);

  test("concurrent opens of one file, and of a hard link to it, all work", async (ctx) => {
    // A second backing id for an inode that already has one makes the
    // kernel fail the open with EIO. Every open here goes through the
    // one shared id instead.
    if (!kernelOffersPassthrough) ctx.skip();
    const result = await run(
      [
        "mkdir -p node_modules",
        "echo shared > node_modules/f",
        "ln -f node_modules/f node_modules/g",
        "exec 3<node_modules/f 4<node_modules/f 5<node_modules/g 6>>node_modules/f",
        "echo more >&6",
        "cat <&3 && cat <&4 && cat <&5",
        "exec 3<&- 4<&- 5<&- 6>&-",
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("shared\nmore\n".repeat(3));
  }, 60_000);

  test("a synced file still reuses the page cache across opens", async () => {
    // auto_cache is gone from the mount options, because the kernel
    // refuses it alongside passthrough. The driver applies the same rule
    // per open instead: an unchanged file keeps its cached pages.
    await run("echo cached > synced.txt && cat synced.txt > /dev/null");
    const warm = await dataOps();
    const result = await run("cat synced.txt && cat synced.txt");
    expect(result.stdout).toBe("cached\ncached\n");
    expect((await dataOps()).read).toBe(warm.read);
  }, 60_000);
});

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolveStream, rejectStream) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolveStream(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", rejectStream);
  });
}

async function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
}
