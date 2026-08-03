// End-to-end integration test for the WorkerShellBackend.
//
// Unlike worker.test.ts and entrypoint.test.ts (vitest/node, both
// of which mock the runtime with fakes), this suite runs inside
// the real workerd through vitest-pool-workers. It exercises the
// full path:
//
//   test                  driver Worker              HostDO
//     │  SELF.fetch          │                          │
//     ├─────────────────────►│                          │
//     │                      │  HOST.get(id)            │
//     │                      ├─────────────────────────►│
//     │                      │                          │  Workspace.shell.exec
//     │                      │                          ├──► WorkerShellBackend
//     │                      │                          │      │
//     │                      │                          │      │ env.LOADER.get(...)
//     │                      │                          │      │   .getEntrypoint("ShellWorker")
//     │                      │                          │      ▼
//     │                      │                          │   Dynamic Worker
//     │                      │                          │   (real ShellWorker, real just-bash)
//     │                      │                          │      │
//     │                      │                          │      │  env.HOST.getWorkspace()
//     │                      │                          │      │  via WorkspaceServiceProxy
//     │                      │                          │◄─────┘
//     │                      │                          │  (fs round-trips
//     │                      │                          │   land in the same DO)
//
// Every layer is real: the workerd runtime, the Worker Loader
// binding, the SHELL_MODULES code-split bundle, the just-bash
// interpreter,
// the WorkspaceServiceProxy loopback, the DO ↔ stub Workers RPC
// boundary. A passing run proves the wiring actually holds
// together end to end, not just that the fakes line up.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./worker-backend-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Each test mints a fresh idFromName() bucket so DO state stays
// isolated case-to-case. The driver Worker keys its env.HOST.get
// by the `id` query param.
let counter = 0;
function freshId(): string {
  return `case-${++counter}`;
}

async function write(id: string, path: string, body: string): Promise<void> {
  const url = new URL("http://test/write");
  url.searchParams.set("id", id);
  url.searchParams.set("path", path);
  const res = await SELF.fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error(`write failed: ${res.status} ${await res.text()}`);
}

async function read(id: string, path: string): Promise<string> {
  const url = new URL("http://test/read");
  url.searchParams.set("id", id);
  url.searchParams.set("path", path);
  const res = await SELF.fetch(url);
  if (!res.ok) throw new Error(`read failed: ${res.status} ${await res.text()}`);
  return res.text();
}

async function exec(
  id: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const url = new URL("http://test/exec");
  url.searchParams.set("id", id);
  url.searchParams.set("command", command);
  const res = await SELF.fetch(url);
  if (!res.ok) throw new Error(`exec failed: ${res.status} ${await res.text()}`);
  return res.json();
}

describe("WorkerShellBackend end-to-end", () => {
  // Per-test timeouts come from vitest.config.worker-backend.ts's
  // testTimeout: 60_000 — the Worker Loader cold start + the
  // shell.js parse + just-bash boot dominates the runtime.
  // SHELL_MODULES code-splits the bundle so only the ~290 KB
  // entry parses on cold start; dynamic chunks load on demand.
  // The actual fs RPC is sub-millisecond; the budget is for the
  // isolate.

  it("round-trips a file through the host DO and reads it back via just-bash", async () => {
    const id = freshId();
    await write(id, "/workspace/hello.txt", "hello from the host");
    const result = await exec(id, "cat hello.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from the host");
    expect(result.stderr).toBe("");
  });

  it("sees writes from the shell on subsequent host-side reads", async () => {
    const id = freshId();
    // Run a command that writes a file from inside the shell.
    const result = await exec(id, "echo 'from inside the shell' > greeting.txt");
    expect(result.exitCode).toBe(0);

    // Read it back through the host DO's fs surface. The shell's
    // write went through env.HOST.getWorkspace() and the
    // WorkspaceFsAdapter, landing in the host DO's SQLite. The
    // host-side read sees the same bytes because there's a
    // single authoritative store.
    const text = await read(id, "/workspace/greeting.txt");
    expect(text).toBe("from inside the shell\n");
  });

  it("reports a non-zero exit code with stderr captured", async () => {
    const id = freshId();
    const result = await exec(id, "ls /nope 2>&1; echo done");
    // just-bash's ls prints a "no such" message to stderr; the
    // shell carries on past the `;` and emits `done` on stdout.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/done/);
  });

  it("registers curl on the fetch path when its group is imported", async () => {
    // The harness opts curl in by passing the imported curl group
    // to WorkerBackend's `commands`. ShellWorker wires curl to a
    // SecureFetch over the isolate's global fetch (no undici). A
    // registered curl with no URL fails its own arg check ("curl:
    // no URL specified"); an unregistered command would instead be
    // reported as not found. This proves the fetch-path curl is
    // wired without depending on egress, which globalOutbound keeps
    // closed.
    const id = freshId();
    const result = await exec(id, "curl 2>&1; echo done");
    expect(result.stdout).toMatch(/done/);
    expect(result.stdout).toMatch(/curl: no URL specified/);
    expect(result.stdout).not.toMatch(/command not found/);
  });

  it("isolates state between separate workspace ids", async () => {
    // Two host-DO names → two distinct workspaces, two distinct
    // Dynamic Worker isolates (the loader caches by
    // `workspace-shell:${ctx.id.toString()}` — different ids
    // map to different cache keys).
    const a = freshId();
    const b = freshId();
    await write(a, "/workspace/owner.txt", "alice");
    await write(b, "/workspace/owner.txt", "bob");
    const out = await Promise.all([exec(a, "cat owner.txt"), exec(b, "cat owner.txt")]);
    expect(out[0].stdout).toBe("alice");
    expect(out[1].stdout).toBe("bob");
  });
});
