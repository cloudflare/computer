// Tests for ShellWorker.
//
// The class is a thin shell over Bash. Its job per call:
//   1. Reach the host Workspace through the DO binding wired
//      into env, by id (also wired into env). Both come from
//      the Worker Loader callback the host DO supplied.
//   2. Build a fresh Bash around a WorkspaceFsAdapter wrapping
//      the workspace's fs surface.
//   3. Run the command and frame the result into the NDJSON
//      event stream the WorkerShellBackend's decoder consumes.
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
import { createGitClient } from "../../git/index.js";
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
      options: {
        cwd?: string;
        env?: Record<string, string>;
        stdin?: Uint8Array;
        signal?: AbortSignal;
      },
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
    getWorkspace(options?: { writable?: boolean }): Promise<FakeWorkspace>;
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

  it("forwards per-execution environment variables to Bash", async () => {
    let observedEnv: Record<string, string> | undefined;
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      observedEnv = options.env;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await drain(
      (await worker.exec({ command: "printenv TOKEN", env: { TOKEN: "secret", EMPTY: "" } }))
        .events,
    );
    expect(observedEnv).toEqual({ TOKEN: "secret", EMPTY: "" });
  });

  it("forwards per-execution stdin bytes to Bash", async () => {
    let observedStdin: Uint8Array | undefined;
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      observedStdin = options.stdin;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const bytes = new TextEncoder().encode("piped");
    await drain((await worker.exec({ command: "cat", stdin: bytes })).events);
    expect(observedStdin).toEqual(bytes);
  });

  it("getExec without a prior exec throws ENOENT", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.getExec({ id: "missing" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("killExec without a prior exec is a no-op", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.killExec({ id: "missing" })).resolves.toBeUndefined();
  });

  it("enforces timeoutMs through just-bash's cooperative abort signal", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      if (options.signal?.aborted) throw options.signal.reason;
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
      throw new Error("unreachable");
    });
    const events = await drain(
      (await worker.exec({ id: "timeout", command: "while true; do :; done", timeoutMs: 5 }))
        .events,
    );
    expect(events).toMatchObject([
      { id: "timeout", name: "stderr", value: "Execution timed out\n" },
      { id: "timeout", name: "exit", value: 124 },
    ]);
  });

  it("kills an in-flight explicit execution id cooperatively", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      if (options.signal?.aborted) throw options.signal.reason;
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
      throw new Error("unreachable");
    });
    const pending = worker.exec({ id: "cancel", command: "sleep 60" });
    await Promise.resolve();
    await worker.killExec({ id: "cancel", signal: "SIGINT" });
    const events = await drain((await pending).events);
    expect(events).toMatchObject([
      { id: "cancel", name: "stderr", value: "Execution cancelled with SIGINT\n" },
      { id: "cancel", name: "exit", value: 130 },
    ]);
  });

  it("fetch() rejects plain HTTP with a clear error", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    const response = await worker.fetch(new Request("http://shell/", { method: "GET" }));
    expect(response.status).toBe(426);
    expect(await response.text()).toMatch(/Workers RPC/);
  });

  // ---------------------------------------------------------------
  // write access
  // ---------------------------------------------------------------
  //
  // Real just-bash against a real Workspace, because the claim being
  // tested is about what a real command does to a real store. The env
  // here calls workspace.stub(options), which is what production does
  // over RPC, so the read-only path under test is the shipped one and
  // not a flag this test set by hand.
  describe("write access", () => {
    let workspace: Workspace;
    const stubs: WorkspaceStub[] = [];

    beforeEach(async () => {
      workspace = new Workspace({
        storage: new SQLiteTestStorage() as never,
        backends: [noopBackend()],
        git: createGitClient(),
      });
      await workspace.ready();
      await workspace.fs.mkdir("/workspace", { recursive: true });
    });

    afterEach(async () => {
      for (const stub of stubs.splice(0)) stub[Symbol.dispose]();
      await workspace.close();
    });

    function envForWorkspace(): FakeEnv {
      return {
        HOST: {
          async getWorkspace(options?: { writable?: boolean }) {
            const stub = workspace.stub(options);
            stubs.push(stub);
            return stub as unknown as FakeWorkspace;
          },
        },
      };
    }

    async function run(command: string, writable?: boolean) {
      const worker = new ShellWorker(undefined as never, envForWorkspace() as never);
      const envelope = await worker.exec({
        command,
        cwd: "/workspace",
        id: `run-${Math.random().toString(36).slice(2)}`,
        writable,
      });
      const events = (await drain(envelope.events)) as { name: string; value: string | number }[];
      return {
        stdout: events
          .filter((e) => e.name === "stdout")
          .map((e) => String(e.value))
          .join(""),
        stderr: events
          .filter((e) => e.name === "stderr")
          .map((e) => String(e.value))
          .join(""),
        exitCode: events.find((e) => e.name === "exit")?.value,
      };
    }

    it("does not delete the workspace when a read-only command tries to", async () => {
      // The case the whole feature exists for. `find -delete` is one
      // command issuing a delete per entry, so a per-write refusal
      // would stop partway and leave a half-deleted tree. Refusing
      // the capability up front means the first delete fails and
      // every file is still there.
      await workspace.fs.writeFile("/workspace/keep.txt", "keep");
      await workspace.fs.mkdir("/workspace/dir", { recursive: true });
      await workspace.fs.writeFile("/workspace/dir/nested.txt", "nested");

      const result = await run("find /workspace -mindepth 1 -delete", false);

      expect(result.exitCode).not.toBe(0);
      expect(await workspace.fs.readFile("/workspace/keep.txt", "utf8")).toBe("keep");
      expect(await workspace.fs.readFile("/workspace/dir/nested.txt", "utf8")).toBe("nested");
    });

    it("deletes the workspace when the same command is allowed to", async () => {
      // The control. Without it the test above would pass just as
      // well against a command that never worked.
      await workspace.fs.writeFile("/workspace/keep.txt", "keep");

      const result = await run("find /workspace -mindepth 1 -delete", true);

      expect(result.exitCode).toBe(0);
      await expect(workspace.fs.readFile("/workspace/keep.txt", "utf8")).rejects.toThrow();
    });

    it("fails a redirect into a new file and creates nothing", async () => {
      const result = await run("echo written > /workspace/new.txt", false);

      expect(result.exitCode).not.toBe(0);
      await expect(workspace.fs.stat("/workspace/new.txt")).rejects.toThrow();
    });

    it("leaves an existing file untouched when a read-only command overwrites it", async () => {
      await workspace.fs.writeFile("/workspace/existing.txt", "original");

      const result = await run("echo replaced > /workspace/existing.txt", false);

      expect(result.exitCode).not.toBe(0);
      expect(await workspace.fs.readFile("/workspace/existing.txt", "utf8")).toBe("original");
    });

    it("still reads while refusing to write", async () => {
      // Read-only has to mean read-only, not broken. A command that
      // only reads must behave exactly as it would with access.
      await workspace.fs.writeFile("/workspace/readable.txt", "contents\n");

      const result = await run("cat /workspace/readable.txt", false);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("contents");
    });

    it("reports the refusal to the command rather than failing silently", async () => {
      // The point of failing the write inside the command: the
      // command sees an error it can act on, and a caller reading
      // stderr can tell what happened.
      await workspace.fs.writeFile("/workspace/existing.txt", "original");

      const result = await run("echo replaced > /workspace/existing.txt", false);

      // Pinned to the reason, not just to non-empty output: a
      // non-zero exit and some stderr would also be produced by the
      // stub being broken, which would make the tests above pass for
      // the wrong reason.
      expect(result.stderr).toMatch(/read-only|EROFS/i);
    });

    it("defaults to writable when the caller does not say", async () => {
      const result = await run("echo written > /workspace/default.txt");

      expect(result.exitCode).toBe(0);
      expect(await workspace.fs.readFile("/workspace/default.txt", "utf8")).toBe("written\n");
    });

    it("keeps concurrent commands' access independent", async () => {
      // Two commands overlap in production, and the capability is
      // per-handle precisely so a read-only one cannot disarm a
      // writable one running beside it.
      await workspace.fs.writeFile("/workspace/shared.txt", "original");

      const [readOnly, writable] = await Promise.all([
        run("echo denied > /workspace/blocked.txt", false),
        run("echo allowed > /workspace/allowed.txt", true),
      ]);

      expect(readOnly.exitCode).not.toBe(0);
      expect(writable.exitCode).toBe(0);
      await expect(workspace.fs.stat("/workspace/blocked.txt")).rejects.toThrow();
      expect(await workspace.fs.readFile("/workspace/allowed.txt", "utf8")).toBe("allowed\n");
    });
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
        git: createGitClient(),
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
