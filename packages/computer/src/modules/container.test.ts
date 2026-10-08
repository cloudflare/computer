import { describe, expect, it } from "vitest";

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFunction,
  WorkspaceModuleHost,
} from "../runtime/types.js";
import type { ExecSyncResult } from "../shell.js";
import { createContainerModule } from "./container.js";

interface ExecOptions {
  readonly backend: string;
  readonly encoding: "utf8";
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly output?: { readonly maxBytes: number; readonly maxLines?: number };
}

interface Run {
  readonly command: string;
  readonly options: ExecOptions;
  killed: boolean;
}

// An in-memory Workspace runtime that records each command and finishes
// it with the given output, or holds it open until it is killed.
function fakeRuntime(output: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  truncated?: Record<string, unknown>;
  sync?: ExecSyncResult;
}) {
  const runs: Run[] = [];
  const runtime = {
    backends: () => [
      { id: "container-shell", protocol: "command" as const, callable: false },
      { id: "linux", protocol: "command" as const, callable: true },
      { id: "worker-javascript", protocol: "module" as const, callable: true },
    ],
    async exec(command: string, options: ExecOptions) {
      const run: Run = { command, options, killed: false };
      runs.push(run);
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      return {
        async result() {
          if (output.hang) await stopped;
          return {
            exitCode: run.killed ? 130 : (output.exitCode ?? 0),
            stdout: output.stdout ?? "",
            stderr: output.stderr ?? "",
            ...(output.truncated === undefined ? {} : { truncated: output.truncated }),
            sync: output.sync ?? { status: "complete" as const, applied: 0, skipped: [] },
          };
        },
        async kill() {
          run.killed = true;
          stop();
        },
      };
    },
  };
  return { runtime, runs };
}

// Build the module's functions the way the backend does when it connects.
function build(
  runtime: ReturnType<typeof fakeRuntime>["runtime"],
  options?: Parameters<typeof createContainerModule>[0],
): { readonly exec: WorkspaceModuleFunction } {
  // SAFETY: The module only calls runtime.exec, and the fake implements the part of WorkspaceRuntime it uses.
  const host = { runtime, git: undefined, artifacts: undefined } as unknown as WorkspaceModuleHost;
  const functions = createContainerModule(options)(host);
  const exec = functions.exec;
  if (!exec) throw new Error("ws:container must export exec");
  return { exec };
}

function callContext(
  overrides: Partial<WorkspaceModuleCallContext> = {},
): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    resolvePath: async (path) => path,
    ...overrides,
  };
}

describe("createContainerModule", () => {
  it("runs the command on the container backend and returns its output", async () => {
    const { runtime, runs } = fakeRuntime({ exitCode: 3, stdout: "out", stderr: "err" });
    const container = build(runtime);

    await expect(
      container.exec(
        ["npm test", { cwd: "/workspace/app", env: { CI: "1" }, stdin: "y\n" }],
        callContext(),
      ),
    ).resolves.toEqual({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
      sync: { status: "complete", skipped: [], skippedCount: 0 },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      command: "npm test",
      options: {
        backend: "container-shell",
        encoding: "utf8",
        cwd: "/workspace/app",
        env: { CI: "1" },
        stdin: "y\n",
      },
    });
  });

  it("uses the configured backend id and omits unset options", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime, { backend: "linux" });

    await container.exec(["ls"], callContext());
    expect(Object.keys(runs[0]?.options ?? {}).sort()).toEqual([
      "backend",
      "encoding",
      "output",
      "timeoutMs",
    ]);
    expect(runs[0]?.options.backend).toBe("linux");
  });

  it("runs the prelude on its own line before each command", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime, { prelude: "set -o pipefail\nexport CI=1" });

    await container.exec(["# comment\nnpm test | tee log"], callContext());
    expect(runs[0]?.command).toBe("set -o pipefail\nexport CI=1\n# comment\nnpm test | tee log");
  });

  it("leaves the command alone with a blank prelude", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime, { prelude: "  " });

    await container.exec(["ls"], callContext());
    expect(runs[0]?.command).toBe("ls");
  });

  it("checks the command before adding the prelude", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime, { prelude: "set -e" });

    await expect(container.exec([" "], callContext())).rejects.toThrow(/non-empty string/);
    expect(runs).toHaveLength(0);
  });

  it("rejects a prelude that is not a string", () => {
    expect(() => createContainerModule({ prelude: 1 as never })).toThrow(
      /prelude must be a string/,
    );
  });

  it("refuses to run on a read-only backend", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime);

    await expect(container.exec(["ls"], callContext({ access: "read" }))).rejects.toThrow(
      /write access/,
    );
    expect(runs).toHaveLength(0);
  });

  it("caps the timeout at the time left before the host call deadline", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime);

    await container.exec(
      ["sleep 1", { timeoutMs: 600_000 }],
      callContext({ deadline: Date.now() + 5_000 }),
    );
    await container.exec(["sleep 1", { timeoutMs: 1_000 }], callContext());
    expect(runs[0]?.options.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(runs[1]?.options.timeoutMs).toBe(1_000);
  });

  it("kills the command when the call is aborted", async () => {
    const { runtime, runs } = fakeRuntime({ hang: true });
    const container = build(runtime);
    const controller = new AbortController();

    const pending = container.exec(["sleep 100"], callContext({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("cancelled"));

    await expect(pending).resolves.toMatchObject({ exitCode: 130 });
    expect(runs[0]?.killed).toBe(true);
  });

  it("does not start a command once the call is aborted", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      container.exec(["ls"], callContext({ signal: controller.signal })),
    ).rejects.toThrow("cancelled");
    expect(runs).toHaveLength(0);
  });

  it("asks the runtime to cut output and passes on where it saved the rest", async () => {
    const saved = {
      status: "saved",
      path: "/.computer/output/container-shell.run.stdout.log",
      totalBytes: 900_000,
      totalLines: 20_000,
      firstLine: 18_001,
      partialLine: false,
    };
    const { runtime, runs } = fakeRuntime({ stdout: "tail\n", truncated: { stdout: saved } });
    const container = build(runtime, { maxOutputBytes: 1024 });

    await expect(container.exec(["npm test"], callContext())).resolves.toEqual({
      exitCode: 0,
      stdout: "tail\n",
      stderr: "",
      truncated: { stdout: saved },
      sync: { status: "complete", skipped: [], skippedCount: 0 },
    });
    expect(runs[0]?.options.output).toEqual({ maxBytes: 1024 });
  });

  it("truncates each stream on UTF-8 boundaries when the runtime did not", async () => {
    const { runtime } = fakeRuntime({ stdout: "a🙂b", stderr: "🙂🙂" });
    const container = build(runtime, { maxOutputBytes: 5 });

    await expect(container.exec(["echo"], callContext())).resolves.toEqual({
      exitCode: 0,
      stdout: "a🙂\n\n[truncated, 1 more bytes]",
      stderr: "🙂\n\n[truncated, 4 more bytes]",
      sync: { status: "complete", skipped: [], skippedCount: 0 },
    });
  });

  it("asks the runtime to keep at most the configured lines", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime, { maxOutputBytes: 2048, maxOutputLines: 200 });

    await container.exec(["npm test"], callContext());
    expect(runs[0]?.options.output).toEqual({ maxBytes: 2048, maxLines: 200 });
  });

  it.each([0, -1, 1.5])("rejects maxOutputLines %s", (maxOutputLines) => {
    expect(() => createContainerModule({ maxOutputLines })).toThrow(/maxOutputLines/);
  });

  it.each([
    ["no arguments", [], /takes a command/],
    ["too many arguments", ["ls", {}, {}], /takes a command/],
    ["an empty command", ["  "], /non-empty string/],
    ["a non-string command", [["ls"]], /non-empty string/],
    ["non-object options", ["ls", "fast"], /options must be an object/],
    ["an unknown option", ["ls", { shell: "zsh" }], /unknown option "shell"/],
    ["a non-string cwd", ["ls", { cwd: 1 }], /cwd must be a string/],
    ["a non-string env value", ["ls", { env: { A: 1 } }], /env "A" must be a string/],
    ["a non-positive timeout", ["ls", { timeoutMs: 0 }], /timeoutMs must be a positive number/],
  ])("rejects %s without running anything", async (_label, args, message) => {
    const { runtime, runs } = fakeRuntime({});
    const container = build(runtime);

    // SAFETY: Each case hands exec arguments that isolate code could send; the cast only widens the test table's inferred type.
    await expect(container.exec(args as never, callContext())).rejects.toThrow(message);
    expect(runs).toHaveLength(0);
  });

  it("rejects a bad maxOutputBytes at construction", () => {
    expect(() => createContainerModule({ maxOutputBytes: 0 })).toThrow(/maxOutputBytes/);
  });

  it("fails when it connects to a Workspace without the backend", () => {
    const { runtime } = fakeRuntime({});
    expect(() => build(runtime, { backend: "missing" })).toThrow(/no backend "missing"/);
  });

  it("accepts a callable shell backend", () => {
    const { runtime } = fakeRuntime({});
    expect(() => build(runtime, { backend: "linux" })).not.toThrow();
  });

  it("refuses a backend that runs module source", () => {
    const { runtime } = fakeRuntime({});
    expect(() => build(runtime, { backend: "worker-javascript" })).toThrow(
      /runs module source, not shell commands/,
    );
  });

  it("reports a sync that has not reached the Workspace, and skipped paths", async () => {
    const { runtime } = fakeRuntime({
      sync: {
        status: "pending",
        applied: 1,
        error: "pull failed",
        skipped: [
          {
            path: "/workspace/ro/x.txt",
            mountRoot: "/workspace/ro",
            op: "write",
            reason: "read-only",
          },
        ],
      },
    });
    const container = build(runtime);

    await expect(container.exec(["touch ro/x.txt"], callContext())).resolves.toMatchObject({
      sync: {
        status: "pending",
        error: "pull failed",
        skipped: ["/workspace/ro/x.txt"],
        skippedCount: 1,
      },
    });
  });

  it("caps a large skipped list so the result fits the bridge limits", async () => {
    const skipped = Array.from({ length: 5000 }, (_, index) => ({
      path: `/workspace/ro/${index}.txt`,
      mountRoot: "/workspace/ro",
      op: "write" as const,
      reason: "read-only" as const,
    }));
    const { runtime } = fakeRuntime({
      sync: { status: "pending", applied: 0, error: "e".repeat(10_000), skipped },
    });
    const container = build(runtime);

    const result = (await container.exec(["touch ro/*"], callContext())) as {
      sync: { skipped: string[]; skippedCount: number; error: string };
    };
    expect(result.sync.skipped).toHaveLength(100);
    expect(result.sync.skippedCount).toBe(5000);
    expect(new TextEncoder().encode(result.sync.error).byteLength).toBeLessThan(1200);
  });

  it("describes itself for a model", () => {
    expect(createContainerModule().description).toContain("full Linux container");
  });
});
