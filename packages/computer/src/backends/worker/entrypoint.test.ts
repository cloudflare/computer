// Tests for ShellWorker.
//
// The class is a thin shell over Bash. Its job per call:
//   1. Reach the host Workspace through the DO binding wired
//      into env, by id (also wired into env). Both come from
//      the Worker Loader callback the host DO supplied.
//   2. Build a fresh Bash around a WorkspaceFsAdapter wrapping
//      the workspace's fs surface.
//   3. Run the command and frame the result into the NDJSON
//      event stream the WorkerBackend's decoder consumes.
//
// No state survives across exec calls. The same workspace stub
// is fetched per call so concurrent execs can't share an
// out-of-date reference and an OOM in Bash takes nothing else
// with it.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeArtifactsBinding } from "../../../tests/utilities/fake-artifacts-binding.js";
import type { ArtifactsCLIInput, ArtifactsCLIResult } from "../../artifacts/index.js";
import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import type { WorkspaceStub } from "../../stub.js";
import { Workspace } from "../../workspace.js";
import { ShellWorker } from "./entrypoint.js";

// In-isolate harness. ShellWorker is constructed without going
// through workerd; the cloudflare-workers-stub aliases handle
// the WorkerEntrypoint base class.
class TestShellWorker extends ShellWorker {
  // Expose Bash class injection so tests don't need just-bash.
  static withFakeBash<E>(
    env: E,
    bashFactory: (
      command: string,
      options: { cwd?: string; signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ): TestShellWorker {
    const w = new TestShellWorker(undefined as never, env as never);
    w.bashFactoryOverride = bashFactory;
    return w;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  if (text === "") return [];
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

interface FakeWorkspace {
  fs: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    writeFile: (path: string, body: string | Uint8Array) => Promise<void>;
  };
  artifacts: { cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> };
  [Symbol.dispose]?: () => void;
}

interface FakeEnv {
  HOST: {
    getWorkspace(): Promise<FakeWorkspace>;
  };
}

function fakeEnv(
  opts: {
    onGetWorkspace?: () => FakeWorkspace;
    artifactsCLI?: (input: ArtifactsCLIInput) => Promise<ArtifactsCLIResult>;
  } = {},
): FakeEnv {
  return {
    HOST: {
      async getWorkspace(): Promise<FakeWorkspace> {
        return (
          opts.onGetWorkspace?.() ?? {
            fs: {
              async readFile() {
                return "";
              },
              async writeFile() {},
            },
            artifacts: {
              cli:
                opts.artifactsCLI ??
                (async () => ({
                  stdout: "",
                  stderr: "artifacts: Workspace Artifacts binding is not configured\n",
                  exitCode: 1,
                })),
            },
          }
        );
      },
    },
  };
}

describe("ShellWorker", () => {
  it("exec returns an envelope with id and a framed event stream", async () => {
    const env = fakeEnv();
    const worker = TestShellWorker.withFakeBash(env, async () => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    }));
    const envelope = await worker.exec({ command: "echo hello", id: "run-1" });
    expect(envelope.id).toBe("run-1");
    const events = await drain(envelope.events);
    expect(events).toEqual([
      { id: "run-1", seq: 1, name: "stdout", value: "hello\n" },
      { id: "run-1", seq: 2, name: "exit", value: 0 },
    ]);
  });

  it("emits stderr alongside stdout when both are produced", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async () => ({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 2,
    }));
    const events = await drain((await worker.exec({ command: "x" })).events);
    expect((events[0] as { name: string }).name).toBe("stdout");
    expect((events[1] as { name: string }).name).toBe("stderr");
    expect(events[2]).toMatchObject({ name: "exit", value: 2 });
  });

  it("skips empty stdout/stderr events", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const events = await drain((await worker.exec({ command: "true" })).events);
    expect(events).toEqual([{ id: expect.any(String), seq: 1, name: "exit", value: 0 }]);
  });

  it("looks up the workspace through env.HOST per call", async () => {
    let getWorkspaceCalls = 0;
    const env = fakeEnv({
      onGetWorkspace: () => {
        getWorkspaceCalls += 1;
        return {
          fs: {
            async readFile() {
              return "";
            },
            async writeFile() {},
          },
        };
      },
    });
    // Concurrent execs in the same isolate get their own stubs;
    // pin this behaviour because it's the property that made us
    // pick the per-call lookup over a stored fs reference.
    const worker = TestShellWorker.withFakeBash(env, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await drain((await worker.exec({ command: "a" })).events);
    await drain((await worker.exec({ command: "b" })).events);
    expect(getWorkspaceCalls).toBe(2);
  });

  it("forwards cwd to the Bash factory", async () => {
    let observedCwd: string | undefined;
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      observedCwd = options.cwd;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await drain((await worker.exec({ command: "x", cwd: "/workspace/src" })).events);
    expect(observedCwd).toBe("/workspace/src");
  });

  it("getExec without a prior exec throws ENOENT", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.getExec({ id: "missing" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("killExec without a prior exec is a no-op", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.killExec({ id: "missing" })).resolves.toBeUndefined();
  });

  it("fetch() rejects plain HTTP with a clear error", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    const response = await worker.fetch(new Request("http://shell/", { method: "GET" }));
    expect(response.status).toBe(426);
    expect(await response.text()).toMatch(/Workers RPC/);
  });

  // ---------------------------------------------------------------
  // `git` custom command wiring
  // ---------------------------------------------------------------
  //
  // These tests drive real just-bash through `new Bash({...})`
  // against a real `WorkspaceFsAdapter` wrapping a real
  // `Workspace` backed by SQLiteTestStorage. The host stub the
  // env's getWorkspace() hands out is the production
  // `WorkspaceStub` — same shape that crosses the wire in real
  // deployments. The point is to exercise the full filesystem
  // contract Bash relies on (stat-ing cwd at startup, the
  // adapter's readdir / readlink / etc.) rather than discover
  // gaps in production when an unshimmed call lands.
  //
  // The shim's argv-forwarding / stdin-decoding / throw-handling
  // behaviour is unit-tested in `git-command.test.ts`. The
  // standalone `extraCommands` ordering check stays on the
  // bashFactoryOverride seam because it's purely structural.
  describe("`git` custom command wiring", () => {
    let workspace: Workspace;
    let stub: WorkspaceStub;

    beforeEach(async () => {
      workspace = new Workspace({
        storage: new SQLiteTestStorage() as never,
        backends: [noopBackend()],
      });
      await workspace.ready();
      // /workspace is the ShellWorker's default cwd; create it
      // up front so Bash's startup stat() resolves.
      await workspace.fs.mkdir("/workspace", { recursive: true });
      stub = workspace.stub();
    });

    afterEach(async () => {
      stub[Symbol.dispose]();
      await workspace.close();
    });

    function envFor(ws: WorkspaceStub): FakeEnv {
      return {
        HOST: {
          // Return the real WorkspaceStub. Its shape — fs +
          // shell + git + Symbol.dispose — matches the
          // `HostWorkspaceStub` interface the entrypoint
          // declares structurally.
          async getWorkspace() {
            return ws as unknown as FakeWorkspace;
          },
        },
      };
    }

    it("runs `git version` end-to-end through real Bash and real fs", async () => {
      const worker = new ShellWorker(undefined as never, envFor(stub) as never);
      const envelope = await worker.exec({
        command: "git version",
        cwd: "/workspace",
        id: "run-git",
      });
      const events = (await drain(envelope.events)) as {
        name: string;
        value: string | number;
      }[];
      const stdout = events.find((e) => e.name === "stdout");
      const exit = events.find((e) => e.name === "exit");
      expect(stdout?.value).toContain("@cloudflare/computer");
      expect(exit?.value).toBe(0);
    });

    it("runs `git diff` end-to-end and observes a working-tree change", async () => {
      // Seed a one-commit repo through the workspace's own git
      // surface. We drive isomorphic-git directly through the
      // adapter to avoid spinning up an HTTP server; the same
      // bytes a `git init && git add && git commit` would write
      // land in the workspace's SQLite store.
      const { workspaceIsomorphicGitClient } = await import("../../git/adapter.js");
      const isogit = await import("isomorphic-git");
      const git = (isogit.default ?? isogit) as typeof isogit;
      const fs = await workspaceIsomorphicGitClient(workspace.provider());
      const dir = "/workspace";
      await git.init({ fs: fs as unknown as object, dir, defaultBranch: "main" });
      await workspace.fs.writeFile("/workspace/a.txt", "hello\n");
      await git.add({ fs: fs as unknown as object, dir, filepath: "a.txt" });
      await git.commit({
        fs: fs as unknown as object,
        dir,
        message: "init",
        author: { name: "t", email: "t@example.test" },
      });
      // Mutate the working tree so the diff is non-empty.
      await workspace.fs.writeFile("/workspace/a.txt", "hello world\n");

      const worker = new ShellWorker(undefined as never, envFor(stub) as never);
      const envelope = await worker.exec({
        command: "git diff",
        cwd: "/workspace",
      });
      const events = (await drain(envelope.events)) as {
        name: string;
        value: string | number;
      }[];
      const stdout = events.find((e) => e.name === "stdout");
      const exit = events.find((e) => e.name === "exit");
      expect(exit?.value).toBe(0);
      expect(typeof stdout?.value).toBe("string");
      expect(stdout?.value as string).toContain("--- a.txt");
      expect(stdout?.value as string).toContain("+hello world");
    });

    it("unknown subcommands exit 1 with a git-shaped stderr line", async () => {
      const worker = new ShellWorker(undefined as never, envFor(stub) as never);
      const events = (await drain(
        (
          await worker.exec({ command: "git nope", cwd: "/workspace" })
        ).events,
      )) as { name: string; value: string | number }[];
      const stderr = events.find((e) => e.name === "stderr");
      const exit = events.find((e) => e.name === "exit");
      expect(stderr?.value).toContain("'nope' is not a supported workspace git command");
      expect(exit?.value).toBe(1);
    });
  });

  describe("`assets` custom command wiring", () => {
    it("runs `assets publish` end-to-end through real Bash", async () => {
      const calls: Array<{ path: string; expiresAfter: number }> = [];
      const workspace = new Workspace({
        storage: new SQLiteTestStorage() as never,
        backends: [noopBackend()],
        assets: {
          async share(path, options) {
            calls.push({ path, expiresAfter: options.expiresAfter });
            return "https://example.com/shared.txt";
          },
        },
      });
      await workspace.ready();
      await workspace.fs.mkdir("/workspace", { recursive: true });
      const stub = workspace.stub();
      try {
        const worker = new ShellWorker(
          undefined as never,
          {
            HOST: {
              async getWorkspace() {
                return stub as unknown as FakeWorkspace;
              },
            },
          } as never,
        );
        const events = (await drain(
          (
            await worker.exec({ command: "assets publish out.txt 30s", cwd: "/workspace" })
          ).events,
        )) as { name: string; value: string | number }[];
        const stdout = events.find((e) => e.name === "stdout");
        const exit = events.find((e) => e.name === "exit");
        expect(stdout?.value).toBe("https://example.com/shared.txt\n");
        expect(exit?.value).toBe(0);
        expect(calls).toEqual([{ path: "/workspace/out.txt", expiresAfter: 30_000 }]);
      } finally {
        stub[Symbol.dispose]();
        await workspace.close();
      }
    });
  });

  describe("`artifacts` custom command wiring", () => {
    it("runs `artifacts repo list` end-to-end through real Bash", async () => {
      const workspace = new Workspace({
        storage: new SQLiteTestStorage() as never,
        backends: [noopBackend()],
        sessionId: "sess1",
        artifacts: { binding: new FakeArtifactsBinding() },
      });
      await workspace.ready();
      await workspace.fs.mkdir("/workspace", { recursive: true });
      const stub = workspace.stub();
      try {
        const worker = new ShellWorker(
          undefined as never,
          {
            HOST: {
              async getWorkspace() {
                return stub as unknown as FakeWorkspace;
              },
            },
          } as never,
        );
        const events = (await drain(
          (
            await worker.exec({ command: "artifacts repo list", cwd: "/workspace" })
          ).events,
        )) as { name: string; value: string | number }[];
        const stdout = events.find((e) => e.name === "stdout");
        const exit = events.find((e) => e.name === "exit");
        expect(stdout?.value).toBe("[]\n");
        expect(exit?.value).toBe(0);
      } finally {
        stub[Symbol.dispose]();
        await workspace.close();
      }
    });
  });

  // Lightweight structural check that doesn't need a real fs: the
  // protected extraCommands() hook is invoked and its output is
  // appended after the built-in commands.
  describe("`extraCommands` ordering", () => {
    it("appends extraCommands() output after the built-in commands", async () => {
      let seen: import("just-bash").CustomCommand[] = [];
      class WithExtras extends ShellWorker {
        protected override extraCommands(): import("just-bash").CustomCommand[] {
          return [
            { name: "alpha", execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
            { name: "beta", execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
          ];
        }
      }
      class TestWithExtras extends WithExtras {
        static spy() {
          const w = new TestWithExtras(undefined as never, fakeEnv() as never);
          w.bashFactoryOverride = async (_cmd, options) => {
            seen = options.customCommands;
            return { stdout: "", stderr: "", exitCode: 0 };
          };
          return w;
        }
      }
      const worker = TestWithExtras.spy();
      await drain((await worker.exec({ command: "alpha" })).events);
      expect(seen.map((c) => c.name)).toEqual(["git", "assets", "artifacts", "alpha", "beta"]);
    });
  });
});

// A backend that satisfies Workspace.ready() without exercising
// the sync or shell wire. Same shape adapter.test.ts uses.
function noopBackend(): WorkspaceBackend {
  return {
    id: "noop",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: {
          sync: new Proxy(
            {},
            {
              get() {
                throw new Error("sync wire must not be reached");
              },
            },
          ) as never,
          shell: new Proxy(
            {},
            {
              get() {
                throw new Error("shell wire must not be reached");
              },
            },
          ) as never,
        },
        sync: "none",
        close: async () => {},
      };
    },
  };
}
