import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { seedFixture } from "./seed";
import {
  createWorkspaceCommandRunner,
  createWorkspaceFileStore,
  createWorkspaceFixtureRuntime,
} from "./workspace";

describe("createWorkspaceFixtureRuntime", () => {
  test("seeds through Workspace.fs without connecting a shell backend", async () => {
    const calls: Array<{ type: "mkdir" | "write"; path: string; contents?: string }> = [];
    const workspace = {
      fs: {
        async mkdir(path: string, options?: { recursive?: boolean }) {
          if (options?.recursive !== true) {
            throw new Error("Workspace fixture mkdir must be recursive");
          }
          calls.push({ type: "mkdir", path });
        },
        async writeFile(path: string, contents: string) {
          calls.push({ type: "write", path, contents });
        },
      },
      async ready() {
        throw new Error("ready() should not be needed for file seeding");
      },
    };

    await seedFixture(createWorkspaceFixtureRuntime(workspace), comparisonFixture);

    expect(calls).toEqual(expectedSeedCalls());
  });

  test("adapts Workspace.fs to the text file store interface", async () => {
    const calls: string[] = [];
    const workspace = {
      fs: {
        async readFile(path: string, encoding: "utf8") {
          calls.push(`read ${path} ${encoding}`);
          return "contents";
        },
        async writeFile(path: string, contents: string) {
          calls.push(`write ${path} ${contents}`);
        },
      },
    };
    const store = createWorkspaceFileStore(workspace);

    await expect(store.readFile("/workspace/repo/src/index.ts")).resolves.toBe("contents");
    await store.writeFile("/workspace/repo/src/index.ts", "updated");

    expect(calls).toEqual([
      "read /workspace/repo/src/index.ts utf8",
      "write /workspace/repo/src/index.ts updated",
    ]);
  });

  test("exec routes package commands to the Workspace container backend", async () => {
    const calls: string[] = [];
    const runner = createWorkspaceCommandRunner({
      async ready(backend?: string) {
        calls.push(`ready ${backend ?? "default"}`);
      },
      shell: {
        async exec(
          command: string,
          options?: { backend?: string; cwd?: string; encoding?: "utf8"; timeoutMs?: number },
        ) {
          calls.push(
            `${command} ${options?.backend} ${options?.cwd} ${options?.encoding} ${options?.timeoutMs}`,
          );
          return {
            async result() {
              calls.push("result");
              return { exitCode: 0, stdout: "workspace\n", stderr: "", pushed: 1, pulled: 1 };
            },
          };
        },
      },
    });

    await expect(
      runner.exec("npm run check", { cwd: "/workspace/repo", timeoutMs: 30_000 }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "workspace\n",
      stderr: "",
      executionTarget: "computer-container",
    });
    expect(calls).toEqual([
      "ready container",
      "npm run check container /workspace/repo utf8 30000",
      "result",
    ]);
  });

  test.each([
    "grep -R node docs",
    "cat package.json | grep npm",
    "find . -name package.json",
    "ls docs/workers",
    "pwd",
  ])("exec keeps generic Workspace inspection on the worker shell backend: %s", async (command) => {
    const calls: string[] = [];
    const runner = createWorkspaceCommandRunner({
      async ready(backend?: string) {
        calls.push(`ready ${backend ?? "default"}`);
      },
      shell: {
        async exec(
          actualCommand: string,
          options?: { backend?: string; cwd?: string; encoding?: "utf8" },
        ) {
          calls.push(`${actualCommand} ${options?.backend} ${options?.cwd} ${options?.encoding}`);
          return {
            async result() {
              return { exitCode: 0, stdout: "workspace\n", stderr: "", pushed: 0, pulled: 0 };
            },
          };
        },
      },
    });

    await expect(runner.exec(command, { cwd: "/workspace/repo" })).resolves.toEqual({
      exitCode: 0,
      stdout: "workspace\n",
      stderr: "",
      executionTarget: "worker-shell",
    });

    expect(calls).toEqual(["ready shell", `${command} shell /workspace/repo utf8`]);
  });

  test.each([
    "npm run check",
    "node scripts/check-docs.mjs",
    "npx vitest",
    "tsc --noEmit",
    "./scripts/check-docs.mjs",
  ])(
    "exec routes runtime and package commands to the Workspace container backend: %s",
    async (command) => {
      const calls: string[] = [];
      const runner = createWorkspaceCommandRunner({
        async ready(backend?: string) {
          calls.push(`ready ${backend ?? "default"}`);
        },
        shell: {
          async exec(
            actualCommand: string,
            options?: { backend?: string; cwd?: string; encoding?: "utf8" },
          ) {
            calls.push(`${actualCommand} ${options?.backend} ${options?.cwd} ${options?.encoding}`);
            return {
              async result() {
                return { exitCode: 0, stdout: "workspace\n", stderr: "", pushed: 1, pulled: 1 };
              },
            };
          },
        },
      });

      await expect(runner.exec(command, { cwd: "/workspace/repo" })).resolves.toMatchObject({
        exitCode: 0,
        stdout: "workspace\n",
        stderr: "",
        executionTarget: "computer-container",
      });

      expect(calls).toEqual(["ready container", `${command} container /workspace/repo utf8`]);
    },
  );
});

function expectedSeedCalls(): Array<{ type: "mkdir" | "write"; path: string; contents?: string }> {
  const files = comparisonFixture.files.map((file) => ({
    ...file,
    path: `${comparisonFixture.root}/${file.path}`,
  }));
  const parentDirs = [
    ...new Set(
      files
        .map((file) => file.path.slice(0, file.path.lastIndexOf("/")))
        .filter((directory) => directory !== comparisonFixture.root),
    ),
  ];

  return [
    { type: "mkdir", path: comparisonFixture.root },
    ...parentDirs.map((directory) => ({ type: "mkdir" as const, path: directory })),
    ...files.map((file) => ({ type: "write" as const, path: file.path, contents: file.contents })),
  ];
}
