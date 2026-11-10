/**
 * Concurrent syncing calls take turns and pull only their own changes. An abort SIGKILLs
 * everything the command started and skips the pull. Background processes don't outlive their
 * call, and a command still running when the code ends is killed, freeing the root's lock. A
 * command that can't start rejects exec(), and commands get the image's environment.
 */
import { afterAll, describe, expect, it } from "vitest";
import { workspace } from "./workspace";

const ws = workspace("processes");
afterAll(() => ws.destroy());

describe("processes", () => {
  it("lets syncing calls take turns, each pulling back only its own command's changes", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const options = { push: ["par/**"], pull: ["par/**"] };
          const run = async (script) => (await exec(["sh", "-c", script], options)).output();
          const [a, b] = await Promise.all([
            run("sleep 1; mkdir -p par && echo A > par/a.txt"),
            run("sleep 1; mkdir -p par && echo B > par/b.txt"),
          ]);
          const waits = [a.sync.pushed.lockWaitMs, b.sync.pushed.lockWaitMs].sort((x, y) => x - y);
          return {
            pulled: [a.sync.pulled.files, b.sync.pulled.files],
            firstWaited: waits[0] > 500,
            secondWaited: waits[1] > 500,
          };
        }
      `),
    ).toEqual({ pulled: [1, 1], firstWaited: false, secondWaited: true });
    expect(await ws.get("par/a.txt")).toBe("A\n");
    expect(await ws.get("par/b.txt")).toBe("B\n");
  });

  it("SIGKILLs everything an aborted command started, and skips its pull", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const count = async () => {
            const { stdout } = await (await exec(["pgrep", "-c", "-f", "sleep 300$"])).output();
            return new TextDecoder().decode(stdout).trim();
          };
          const controller = new AbortController();
          const p = await exec(["sh", "-c", "sleep 300 & sleep 300 & wait"], {
            signal: controller.signal,
            pull: ["**"],
          });
          const before = await count();
          controller.abort();
          const { exitCode, sync } = await p.output();
          return { before, exitCode, pulled: sync.pulled.status, after: await count() };
        }
      `),
    ).toEqual({ before: "2", exitCode: 137, pulled: "skipped", after: "0" });
  });

  it("doesn't let background processes outlive their call", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const decoder = new TextDecoder();
          const run = async (argv) => decoder.decode((await (await exec(argv)).output()).stdout);
          const started = await run(["sh", "-c", "setsid sleep 301 & echo started"]);
          return { started, sleeping: (await run(["pgrep", "-c", "-f", "sleep 301$"])).trim() };
        }
      `),
    ).toEqual({ started: "started\n", sleeping: "0" });
  });

  it("kills a command still running when the code ends", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          await exec(["sleep", "302"], { stdout: "ignore", stderr: "ignore" });
          return "returned";
        }
      `),
    ).toBe("returned");
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const { stdout } = await (await exec(["pgrep", "-c", "-f", "sleep 302$"])).output();
          return new TextDecoder().decode(stdout).trim();
        }
      `),
    ).toBe("0");
  });

  it("frees the lock of a syncing command left unread when the code ends", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          // Holds the root's lock, and its output fills its pipe; nobody reads it.
          await exec(["sh", "-c", "seq 1 1000000; sleep 300"], { pull: ["unread/**"] });
          return "returned";
        }
      `),
    ).toBe("returned");
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const proc = await exec(["true"], { push: ["unread/**"], lockTimeoutMs: 10000 });
          const { exitCode, sync } = await proc.output();
          return { exitCode, waitedLong: sync.pushed.lockWaitMs > 5000 };
        }
      `),
    ).toEqual({ exitCode: 0, waitedLong: false });
  });

  it("rejects exec() for a command that can't start", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          return await exec(["/no/such/thing"]).catch((error) => String(error));
        }
      `),
    ).toBe("RemoteExecError: exec: /no/such/thing: No such file or directory (os error 2)");
  });

  it("starts commands with the image's environment, under their own env", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const decoder = new TextDecoder();
          const run = async (options) =>
            decoder.decode((await (await exec(["sh", "-c", 'echo "$IMAGE_ENV"'], options)).output()).stdout);
          return { image: await run(), own: await run({ env: { IMAGE_ENV: "from-the-call" } }) };
        }
      `),
    ).toEqual({ image: "from-the-image\n", own: "from-the-call\n" });
  });
});
