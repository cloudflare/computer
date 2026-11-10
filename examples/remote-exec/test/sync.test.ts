/**
 * Push with .gitignore, run, then pull, including deletions, with ignored files kept out in both
 * directions. A second push sends only what changed; push and pull globs are relative to cwd; a
 * command can run as another user, who owns the files pushed for it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspace } from "./workspace";

const ws = workspace("sync");
afterAll(() => ws.destroy());

const report = (overrides: Record<string, unknown>) => ({
  status: "done",
  deleted: [],
  deletedCount: 0,
  skipped: [],
  skippedCount: 0,
  conflicts: [],
  lockWaitMs: 0,
  ...overrides,
});

describe("sync", () => {
  beforeAll(async () => {
    await ws.put(".gitignore", "node_modules/\n*.log\n");
    await ws.put("app/src/main.js", 'console.log("hello from", process.argv[2] ?? "nobody");\n');
    await ws.put("app/src/data.txt", "one\ntwo\nthree\n");
    await ws.put("app/debug.log", "ignored by .gitignore\n");
    await ws.put("app/node_modules/dep/index.js", "ignored too\n");
    await ws.put("app/stale.txt", "the command deletes me\n");
  });

  it("pushes the files, runs the command and pulls back what it changed", async () => {
    const result = await ws.run(`
      import { exec } from "codemode:exec";

      export default async function () {
        const proc = await exec(
          [
            "sh",
            "-c",
            [
              "find app -type f | sort",
              "node app/src/main.js codemode",
              "mkdir -p app/out && wc -l < app/src/data.txt > app/out/count.txt",
              "tr a-z A-Z < app/src/data.txt > app/src/data.tmp && mv app/src/data.tmp app/src/data.txt",
              "rm app/stale.txt",
              "mkdir -p app/node_modules/new && echo x > app/node_modules/new/index.js",
              "echo to-stderr >&2",
            ].join(" && "),
          ],
          { cwd: "/workspace", push: ["app/**", ".gitignore"], pull: ["app/**"] },
        );
        const { exitCode, stdout, stderr, sync } = await proc.output();
        const decoder = new TextDecoder();
        return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr), sync };
      }
    `);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "app/src/data.txt\napp/src/main.js\napp/stale.txt\nhello from codemode\n",
      stderr: "to-stderr\n",
      sync: {
        pushed: report({ files: 4, transferred: 4, bytes: 113 }),
        pulled: report({
          files: 2,
          transferred: 2,
          bytes: 16,
          deleted: ["app/stale.txt"],
          deletedCount: 1,
        }),
      },
    });
    // The command's changes are in the workspace, and ignored files stayed out both ways.
    expect(await ws.get("app/out/count.txt")).toBe("3\n");
    expect(await ws.get("app/src/data.txt")).toBe("ONE\nTWO\nTHREE\n");
    expect(await ws.get("app/stale.txt")).toBeUndefined();
    expect(await ws.get("app/node_modules/new/index.js")).toBeUndefined();
  });

  it("sends only the files that changed on a second push", async () => {
    await ws.put("app/src/data.txt", "changed in the workspace\n");
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const { stdout, sync } = await (await exec(["cat", "app/src/data.txt"], { push: ["app/**"] })).output();
          return { stdout: new TextDecoder().decode(stdout), pushed: sync.pushed };
        }
      `),
    ).toEqual({
      stdout: "changed in the workspace\n",
      pushed: report({ files: 3, transferred: 1, bytes: 25 }),
    });
  });

  it("takes push and pull paths relative to cwd", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const proc = await exec(["sh", "-c", "ls; echo made > made.txt"], {
            cwd: "/workspace/app/src",
            push: ["*.js"],
            pull: ["*.txt"],
          });
          const { stdout, sync } = await proc.output();
          return { stdout: new TextDecoder().decode(stdout), pushed: sync.pushed.files, pulled: sync.pulled.files };
        }
      `),
    ).toEqual({ stdout: "data.txt\nmain.js\n", pushed: 1, pulled: 1 });
    expect(await ws.get("app/src/made.txt")).toBe("made\n");
  });

  it("runs a command as another user, who owns the files pushed for it", async () => {
    await ws.put("u/file.txt", "mine\n");
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const proc = await exec(
            ["sh", "-c", "id -u; id -g; stat -c %u:%g u u/file.txt; touch u/made.txt"],
            { user: "1000:1000", push: ["u/**"], pull: ["u/**"] },
          );
          const { stdout } = await proc.output();
          return new TextDecoder().decode(stdout).trim().split("\\n");
        }
      `),
    ).toEqual(["1000", "1000", "1000:1000", "1000:1000"]);
    expect(await ws.get("u/made.txt")).toBe("");
  });
});
