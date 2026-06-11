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
    ).resolves.toEqual({ exitCode: 0, stdout: "workspace\n", stderr: "" });
    expect(calls).toEqual([
      "ready container",
      "npm run check container /workspace/repo utf8 30000",
      "result",
    ]);
  });

  test("exec keeps generic Workspace commands on the worker shell backend", async () => {
    const calls: string[] = [];
    const runner = createWorkspaceCommandRunner({
      async ready(backend?: string) {
        calls.push(`ready ${backend ?? "default"}`);
      },
      shell: {
        async exec(
          command: string,
          options?: { backend?: string; cwd?: string; encoding?: "utf8" },
        ) {
          calls.push(`${command} ${options?.backend} ${options?.cwd} ${options?.encoding}`);
          return {
            async result() {
              return { exitCode: 0, stdout: "workspace\n", stderr: "", pushed: 0, pulled: 0 };
            },
          };
        },
      },
    });

    await runner.exec("grep -R Smart docs", { cwd: "/workspace/repo" });

    expect(calls).toEqual(["ready shell", "grep -R Smart docs shell /workspace/repo utf8"]);
  });
});

function expectedSeedCalls(): Array<{ type: "mkdir" | "write"; path: string; contents?: string }> {
  return [
    { type: "mkdir", path: comparisonFixture.root },
    ...comparisonFixture.files.flatMap((file) => {
      const path = `${comparisonFixture.root}/${file.path}`;
      const directory = path.slice(0, path.lastIndexOf("/"));
      const calls: Array<{ type: "mkdir" | "write"; path: string; contents?: string }> = [];
      if (directory !== comparisonFixture.root) calls.push({ type: "mkdir", path: directory });
      calls.push({ type: "write", path, contents: file.contents });
      return calls;
    }),
  ];
}
