/**
 * The process exec() returns: its streams and `stdin: "pipe"`, exitCode waiting for both pipes,
 * output() as bytes and only once, a stream as stdin and `stderr: "combined"`, a failing command's
 * exit code and kill(), and long output keeping its last 2,000 lines, with the rest saved.
 */
import { afterAll, describe, expect, it } from "vitest";
import { workspace } from "./workspace";

const ws = workspace("streams");
afterAll(() => ws.destroy());

describe("streams", () => {
  it("returns a process like ctx.container.exec()'s, and streams stdin, stdout and stderr", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const p = await exec(["sh", "-c", 'while read line; do echo "got: $line"; done; echo done >&2'], {
            stdin: "pipe",
          });
          const writer = p.stdin.getWriter();
          const encoder = new TextEncoder();
          await writer.write(encoder.encode("a\\n"));
          await writer.write(encoder.encode("b\\n"));
          await writer.close();
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exitCode,
          ]);
          return { pid: p.pid > 1, isPty: p.isPty, stdout, stderr, exitCode };
        }
      `),
    ).toEqual({
      pid: true,
      isPty: false,
      stdout: "got: a\ngot: b\n",
      stderr: "done\n",
      exitCode: 0,
    });
  });

  it("resolves exitCode once the pipes are read to the end, or cancelled, as on the platform", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        const within = (promise, ms) =>
          Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("pending"), ms))]);

        export default async function () {
          const unread = await exec(["sh", "-c", "echo out; echo err >&2"]);
          const half = await exec(["sh", "-c", "echo out; echo err >&2"]);
          // Before reading stdout: neither pipe ends until both are read or cancelled.
          await half.stderr.cancel();
          const stdout = await new Response(half.stdout).text();
          return {
            unread: await within(unread.exitCode, 2000),
            stdout,
            readAndCancelled: await within(half.exitCode, 5000),
          };
        }
      `),
    ).toEqual({ unread: "pending", stdout: "out\n", readAndCancelled: 0 });
  });

  it("gives output() as bytes, once, and only before the streams are read", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        const refusal = (promise) => promise.then(() => "ran", (error) => error.message);

        export default async function () {
          const p = await exec(["printf", "bytes\\\\000ok"]);
          const { stdout, stderr } = await p.output();
          const read = await exec(["echo", "x"]);
          await new Response(read.stdout).text();
          return {
            stdout: Array.from(new Uint8Array(stdout)),
            stderr: stderr.byteLength,
            again: await refusal(p.output()),
            afterReading: await refusal(read.output()),
          };
        }
      `),
    ).toEqual({
      stdout: [98, 121, 116, 101, 115, 0, 111, 107],
      stderr: 0,
      again: "exec: output() can only be called once",
      afterReading:
        "exec: output() reads stdout and stderr, so it can't be called once either has been read",
    });
  });

  it("takes a stream as stdin, and can send stderr to stdout", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const p = await exec(["sh", "-c", "cat; echo oops >&2; cat /no/such/file"], {
            stdin: new Blob(["from ", "stdin\\n"]).stream(),
            stderr: "combined",
          });
          const { stdout, stderr } = await p.output();
          const decoder = new TextDecoder();
          return { stdin: p.stdin, stderrStream: p.stderr, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
        }
      `),
    ).toEqual({
      stdin: null,
      stderrStream: null,
      stdout: "from stdin\noops\ncat: /no/such/file: No such file or directory\n",
      stderr: "",
    });
  });

  it("resolves a failing command with its exit code, and kill() signals one", async () => {
    expect(
      await ws.run(`
        import { exec } from "codemode:exec";

        export default async function () {
          const failing = await (await exec(["sh", "-c", "echo partial; exit 3"])).output();
          const sleeping = await exec(["sleep", "100"], { stdout: "ignore", stderr: "ignore" });
          sleeping.kill(15);
          return {
            exitCode: failing.exitCode,
            stdout: new TextDecoder().decode(failing.stdout),
            killed: await sleeping.exitCode,
          };
        }
      `),
    ).toEqual({ exitCode: 3, stdout: "partial\n", killed: 143 });
  });

  it("keeps long output's last 2,000 lines and saves the rest in the workspace", async () => {
    const result = (await ws.run(`
      import { exec } from "codemode:exec";
      import { readFile } from "node:fs/promises";

      export default async function () {
        const { stdout, truncated } = await (await exec(["seq", "1", "100000"])).output();
        const saved = await readFile(truncated.stdout.path, "utf8");
        const lines = new TextDecoder().decode(stdout).trimEnd().split("\\n");
        return {
          lines: lines.length,
          first: lines[0],
          last: lines.at(-1),
          truncated,
          savedLines: saved.trimEnd().split("\\n").length,
        };
      }
    `)) as { truncated: { stdout: { path: string } } };
    expect(result).toEqual({
      lines: 2000,
      first: "98001",
      last: "100000",
      truncated: {
        stdout: {
          status: "saved",
          path: expect.stringMatching(/^\/\.computer\/output\/.+\.stdout\.log$/),
          totalBytes: 588895,
          totalLines: 100000,
          firstLine: 98001,
          partialLine: false,
        },
      },
      savedLines: 100000,
    });
  });
});
