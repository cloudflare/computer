import { describe, expect, test } from "vitest";
import type { ComparisonFixture } from "../../shared/fixture";
import { seedFixture } from "./seed";

describe("seedFixture", () => {
  test("creates parent directories and writes fixture files under the root", async () => {
    const calls: string[] = [];
    const fixture: ComparisonFixture = {
      root: "/workspace/repo",
      task: "Test task",
      files: [
        { path: "package.json", contents: "{}\n" },
        { path: "src/index.ts", contents: "export {};\n" },
      ],
    };

    await seedFixture(
      {
        async mkdir(path) {
          calls.push(`mkdir ${path}`);
        },
        async writeFile(path, contents) {
          calls.push(`write ${path} ${contents.length}`);
        },
      },
      fixture,
    );

    expect(calls[0]).toBe("mkdir /workspace/repo");
    expect(calls.slice(1).sort()).toEqual([
      "mkdir /workspace/repo/src",
      "write /workspace/repo/package.json 3",
      "write /workspace/repo/src/index.ts 11",
    ]);
  });
});
