import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import {
  createSandboxCommandRunner,
  createSandboxFileStore,
  createSandboxFixtureRuntime,
} from "./sandbox";
import { seedFixture } from "./seed";

describe("createSandboxFixtureRuntime", () => {
  test("seeds through Sandbox file operations", async () => {
    const calls: Array<{ type: "mkdir" | "write"; path: string; contents?: string }> = [];
    const sandbox = {
      async mkdir(path: string, options?: { recursive?: boolean }) {
        if (options?.recursive !== true) {
          throw new Error("Sandbox fixture mkdir must be recursive");
        }
        calls.push({ type: "mkdir", path });
      },
      async writeFile(path: string, contents: string) {
        calls.push({ type: "write", path, contents });
      },
    };

    await seedFixture(createSandboxFixtureRuntime(sandbox), comparisonFixture);

    expect(calls).toEqual(expectedSeedCalls());
  });

  test("adapts Sandbox SDK files to the text file store interface", async () => {
    const calls: string[] = [];
    const sandbox = {
      async readFile(path: string) {
        calls.push(`read ${path}`);
        return { content: "contents" };
      },
      async writeFile(path: string, contents: string) {
        calls.push(`write ${path} ${contents}`);
      },
    };
    const store = createSandboxFileStore(sandbox);

    await expect(store.readFile("/workspace/repo/src/index.ts")).resolves.toBe("contents");
    await store.writeFile("/workspace/repo/src/index.ts", "updated");

    expect(calls).toEqual([
      "read /workspace/repo/src/index.ts",
      "write /workspace/repo/src/index.ts updated",
    ]);
  });

  test("exec adapts Sandbox SDK command results", async () => {
    const calls: string[] = [];
    const runner = createSandboxCommandRunner({
      async exec(command: string, options?: { cwd?: string; timeout?: number }) {
        calls.push(`${command} ${options?.cwd} ${options?.timeout}`);
        return {
          success: true,
          exitCode: 0,
          stdout: "sandbox\n",
          stderr: "",
          command,
          duration: 12,
          timestamp: "2026-06-04T00:00:00.000Z",
        };
      },
    });

    await expect(
      runner.exec("npm test", { cwd: "/workspace/repo", timeoutMs: 30_000 }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "sandbox\n",
      stderr: "",
      executionTarget: "sandbox-container",
    });
    expect(calls).toEqual(["npm test /workspace/repo 30000"]);
  });
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
