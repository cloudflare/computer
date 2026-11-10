/**
 * Through POST /s/:session/run-read, on a read-only CodemodeBackend: commands run as nobody with
 * no capabilities, can read pushed files but not change them, and `pull` and `user` are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspace } from "./workspace";

const ws = workspace("read-only");
afterAll(() => ws.destroy());

describe("read-only", () => {
  // Written by an agent that may write.
  beforeAll(() => ws.put("notes.txt", "the parent's notes\n"));

  it("runs commands as nobody, who can read pushed files but not change them", async () => {
    expect(
      await ws.runRead(`
        import { exec } from "codemode:exec";

        export default async function () {
          const proc = await exec(
            ["sh", "-c", "id -u; id -g; stat -c '%U %a' notes.txt; cat notes.txt; echo changed > notes.txt"],
            { push: ["notes.txt"] },
          );
          const { exitCode, stdout, stderr } = await proc.output();
          const decoder = new TextDecoder();
          return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
        }
      `),
    ).toEqual({
      exitCode: 2,
      stdout: "65534\n65534\nroot 644\nthe parent's notes\n",
      stderr: "sh: 1: cannot create notes.txt: Permission denied\n",
    });
    expect(await ws.get("notes.txt")).toBe("the parent's notes\n");
  });

  it("gives commands no capabilities, and no way to gain any", async () => {
    expect(
      await ws.runRead(`
        import { exec } from "codemode:exec";

        export default async function () {
          const proc = await exec(["grep", "-E", "^(CapPrm|CapEff|CapAmb|NoNewPrivs):", "/proc/self/status"]);
          const { stdout } = await proc.output();
          return new TextDecoder().decode(stdout).trim().split("\\n");
        }
      `),
    ).toEqual([
      "CapPrm:\t0000000000000000",
      "CapEff:\t0000000000000000",
      "CapAmb:\t0000000000000000",
      "NoNewPrivs:\t1",
    ]);
  });

  it("refuses pull, and choosing who commands run as", async () => {
    expect(
      await ws.runRead(`
        import { exec } from "codemode:exec";

        const refusal = (promise) => promise.then(() => "ran", (error) => error.message);

        export default async function () {
          return {
            pull: await refusal(exec(["touch", "made.txt"], { pull: ["made.txt"] })),
            user: await refusal(exec(["id", "-u"], { user: "0:0" })),
          };
        }
      `),
    ).toEqual({
      pull: "exec: this agent can only read files, so it can't pull files back into the workspace",
      user: "exec: this agent can only read files, so its commands run as nobody (65534:65534) and it can't choose a user",
    });
    expect(await ws.get("made.txt")).toBeUndefined();
  });
});
