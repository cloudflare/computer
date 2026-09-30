import { describe, expect, it } from "vitest";

import type { WorkspaceTrustedCallContext } from "../../runtime/types.js";
import {
  type ContainerModuleExecOptions,
  type ContainerModuleRuntime,
  createContainerModule,
  describeContainerModule,
} from "./container-module.js";

interface Run {
  readonly command: string;
  readonly options: ContainerModuleExecOptions;
  killed: boolean;
}

// An in-memory runtime that records each command and finishes it with
// the given output, or holds it open until it is killed.
function fakeRuntime(output: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}): { runtime: ContainerModuleRuntime; runs: Run[] } {
  const runs: Run[] = [];
  const runtime: ContainerModuleRuntime = {
    async exec(command, options) {
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

function callContext(overrides: Partial<WorkspaceTrustedCallContext> = {}) {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

describe("createContainerModule", () => {
  it("runs the command on the container backend and returns its output", async () => {
    const { runtime, runs } = fakeRuntime({ exitCode: 3, stdout: "out", stderr: "err" });
    const container = createContainerModule({ runtime: () => runtime });

    await expect(
      container.exec(
        ["npm test", { cwd: "/workspace/app", env: { CI: "1" }, stdin: "y\n" }],
        callContext(),
      ),
    ).resolves.toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
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
    const container = createContainerModule({ runtime: () => runtime, backend: "linux" });

    await container.exec(["ls"], callContext());
    expect(Object.keys(runs[0]?.options ?? {}).sort()).toEqual([
      "backend",
      "encoding",
      "timeoutMs",
    ]);
    expect(runs[0]?.options.backend).toBe("linux");
  });

  it("resolves the runtime on each call, so it can be built before the Workspace", async () => {
    let current: ContainerModuleRuntime | undefined;
    const container = createContainerModule({
      runtime: () => {
        if (!current) throw new Error("Workspace not constructed yet");
        return current;
      },
    });
    const { runtime, runs } = fakeRuntime({});
    current = runtime;

    await container.exec(["true"], callContext());
    expect(runs).toHaveLength(1);
  });

  it("caps the timeout at the time left before the host call deadline", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = createContainerModule({ runtime: () => runtime });

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
    const container = createContainerModule({ runtime: () => runtime });
    const controller = new AbortController();

    const pending = container.exec(["sleep 100"], callContext({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("cancelled"));

    await expect(pending).resolves.toMatchObject({ exitCode: 130 });
    expect(runs[0]?.killed).toBe(true);
  });

  it("does not start a command once the call is aborted", async () => {
    const { runtime, runs } = fakeRuntime({});
    const container = createContainerModule({ runtime: () => runtime });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      container.exec(["ls"], callContext({ signal: controller.signal })),
    ).rejects.toThrow("cancelled");
    expect(runs).toHaveLength(0);
  });

  it("truncates each stream on UTF-8 boundaries", async () => {
    const { runtime } = fakeRuntime({ stdout: "a🙂b", stderr: "🙂🙂" });
    const container = createContainerModule({ runtime: () => runtime, maxOutputBytes: 5 });

    await expect(container.exec(["echo"], callContext())).resolves.toEqual({
      exitCode: 0,
      stdout: "a🙂\n\n[truncated, 1 more bytes]",
      stderr: "🙂\n\n[truncated, 4 more bytes]",
    });
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
    const container = createContainerModule({ runtime: () => runtime });

    // SAFETY: Each case hands exec arguments that isolate code could send; the cast only widens the test table's inferred type.
    await expect(container.exec(args as never, callContext())).rejects.toThrow(message);
    expect(runs).toHaveLength(0);
  });

  it("rejects a bad maxOutputBytes at construction", () => {
    const { runtime } = fakeRuntime({});
    expect(() => createContainerModule({ runtime: () => runtime, maxOutputBytes: 0 })).toThrow(
      /maxOutputBytes/,
    );
  });

  it("describes the module under its installed specifier", () => {
    expect(describeContainerModule("ws:linux")).toContain('import { exec } from "ws:linux"');
    expect(describeContainerModule()).toContain('"ws:container"');
  });
});
