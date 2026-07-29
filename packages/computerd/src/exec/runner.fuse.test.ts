// Regression: computerd must not deadlock when shell.exec passes a cwd
// that lives inside its own FUSE mount.
//
// The shape of the bug, which `runner.ts` now defends against:
//
//   1. computerd holds the FUSE session for MOUNT_POINT (e.g. /workspace).
//   2. Runner.exec calls Node's child_process.spawn. libuv's
//      uv_spawn does fork() + chdir(cwd) + execve() in the child
//      while the parent blocks on a status pipe.
//   3. If the child's chdir target is inside computerd's own FUSE mount,
//      the kernel issues a FUSE LOOKUP that needs to be answered
//      by computerd's event loop.
//   4. computerd's event loop is blocked in uv_spawn waiting for the
//      child's status, so the callback can never run. Deadlock.
//
// The fix: don't pass `cwd` to spawn at all. Pre-flight the path
// via dofs's `stat` (reads SQLite directly, no FUSE callback) for
// the historical ENOENT-cwd contract; then prefix the user's
// command with `cd <quoted> && exec <cmd>` so the shell does the
// chdir after the spawn dance has returned and computerd's event loop
// is responsive again.
//
// Running this test requires:
//   - Docker with /dev/fuse, --privileged, SYS_ADMIN (DinD or
//     native Linux). It boots the linux-x64 computerd SEA binary from
//     artifacts/computerd/ in a privileged container so the kernel FUSE
//     driver is actually in the loop.
//   - The computerd binary built and staged at the path
//     packages/computer/test-harness/run-computerd.sh expects. The
//     test skips itself when either prerequisite is missing so
//     contributors without docker still see green.

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

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function binaryAvailable(): boolean {
  try {
    accessSync(COMPUTERD_BINARY);
    return true;
  } catch {
    return false;
  }
}

const enabled = dockerAvailable() && binaryAvailable();
const describeIfReal = enabled ? describe : describe.skip;

describeIfReal("Runner shell.exec under real FUSE", () => {
  let cid: string | undefined;
  let url: string | undefined;

  beforeAll(async () => {
    // Boot a real-FUSE computerd container via the existing harness
    // helper. The helper prints the URL on stdout and the
    // container id on stderr (COMPUTERD_HARNESS_CID=...).
    const proc = spawn("bash", [RUN_COMPUTERD_SCRIPT], {
      env: { ...process.env, COMPUTERD_HARNESS_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!proc.stdout || !proc.stderr) {
      throw new Error("run-computerd.sh did not expose stdout/stderr pipes");
    }
    const stdout = await drainStream(proc.stdout);
    const stderr = await drainStream(proc.stderr);
    await waitForExit(proc);

    if (proc.exitCode !== 0) {
      throw new Error(`run-computerd.sh exited ${proc.exitCode}: ${stderr}`);
    }
    url = stdout.trim();
    const match = stderr.match(/COMPUTERD_HARNESS_CID=([0-9a-f]+)/);
    if (!match) throw new Error(`could not parse container id from stderr: ${stderr}`);
    cid = match[1];
  }, 90_000);

  afterAll(async () => {
    if (cid) {
      try {
        execFileSync("docker", ["kill", cid], { stdio: "ignore" });
      } catch {
        // Zombie containers from a prior wedge will refuse to
        // die; not our problem to fix here. The host port is
        // released when docker stops tracking the container.
      }
    }
  });

  test("exec(cwd inside the FUSE mount) returns quickly and runs the command", async () => {
    if (!url) throw new Error("computerd container did not start");
    const client = createWorkspaceClient({
      url: `${url.replace(/^http(s?):\/\//, "ws$1://")}/ws`,
      WebSocketImpl: WebSocket,
    });
    try {
      // Pre-fix this hangs forever and wedges the computerd event loop.
      // The 5s ceiling is well under that and well above the
      // ~100ms a healthy exec takes locally, so a regression
      // shows up as a clean failure rather than a CI-wide stall.
      const t0 = Date.now();
      const result = await Promise.race([
        client.shell
          .exec({
            command: "echo hello && pwd",
            cwd: "/workspace",
            timeoutMs: 5_000,
          })
          .then((h) => ({ ok: true as const, h })),
        new Promise<{ ok: false }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ ok: false as const }), 5_000),
        ),
      ]);
      const elapsed = Date.now() - t0;
      expect(result.ok, `exec did not return within 5s (elapsed=${elapsed}ms)`).toBe(true);
      if (!result.ok) return;

      const events: Array<{ name: string; value: unknown }> = [];
      const reader = result.h.events.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const stdout = events
        .filter((e) => e.name === "stdout")
        .map((e) => new TextDecoder().decode(e.value as Uint8Array))
        .join("");
      const exit = events.find((e) => e.name === "exit");
      expect(stdout).toBe("hello\n/workspace\n");
      expect(exit?.value).toBe(0);
    } finally {
      await client.close();
    }
  }, 30_000);
});

async function drainStream(stream: NodeJS.ReadableStream): Promise<string> {
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
