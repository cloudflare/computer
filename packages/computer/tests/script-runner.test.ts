import { SELF } from "cloudflare:test";

async function write(path: string, source: string) {
  const response = await SELF.fetch(`https://example.test/write?path=${encodeURIComponent(path)}`, {
    method: "POST",
    body: source,
  });
  expect(response.status).toBe(204);
}

async function symlink(target: string, path: string) {
  const response = await SELF.fetch(
    `https://example.test/symlink?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}`,
    { method: "POST" },
  );
  expect(response.status).toBe(204);
}

async function read(path: string) {
  const response = await SELF.fetch(`https://example.test/read?path=${encodeURIComponent(path)}`);
  expect(response.status).toBe(200);
  return response.text();
}

async function runtime(body: Record<string, unknown>) {
  return SELF.fetch("https://example.test/runtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("WorkspaceRuntime", () => {
  it("resolves reserved, relative, and literal dynamic Worker Loader modules", async () => {
    const response = await SELF.fetch("https://example.test/module-probe");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).toBe("host:/workspace/probe.txt|relative|trusted");
  });

  it("transfers byte streams across the loader boundary", async () => {
    const response = await SELF.fetch("https://example.test/stdio-probe");
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({
      stdin: "from-host",
      sink: "ok",
      sinkResult: "from-isolate",
    });
  });

  it("executes an ES module with source and host modules", async () => {
    const response = await runtime({
      source: `
        import { double } from "math-kit";
        import fs from "node:fs/promises";
        import { promises as nodeFs } from "node:fs";
        import * as git from "ws:git";
        import { echo, sum, delete as remove } from "ws:test-host";
        export default async function main(input) {
          const value = double(input.value);
          await fs.writeFile("/workspace/runtime-result.txt", String(value));
          const initialized = await git.cli({ argv: ["init"], cwd: "/workspace/repository" });
          return {
            value,
            persisted: await fs.readFile("/workspace/runtime-result.txt", "utf8"),
            gitExitCode: initialized.exitCode,
            trusted: await echo(input.value, "second"),
            summed: await sum(1, 2, 3),
            removed: await remove("/workspace/gone.txt"),
            nodeFs: {
              isFile: (await nodeFs.stat("/workspace/runtime-result.txt")).isFile(),
              entries: await nodeFs.readdir("/workspace"),
            },
          };
        }
      `,
      value: { value: 21 },
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        exitCode: 0,
        value: {
          value: 42,
          persisted: "42",
          gitExitCode: 0,
          trusted: { args: [21, "second"] },
          summed: 6,
          removed: { deleted: "/workspace/gone.txt" },
          nodeFs: {
            isFile: true,
            entries: expect.arrayContaining(["runtime-result.txt"]),
          },
        },
      },
    });
  });

  it("moves bytes through node:fs without inflating them", async () => {
    // 900 bytes fits under this fixture's 1024-byte capability limit as
    // raw bytes. Encoded as JSON numbers it would be about four times
    // larger and rejected.
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        export default async () => {
          await fs.writeFile("/workspace/blob.bin", new Uint8Array(900).fill(255));
          const back = await fs.readFile("/workspace/blob.bin");
          return { isBytes: back instanceof Uint8Array, length: back.byteLength, last: back[899] };
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result, text).toMatchObject({
      status: "completed",
      value: { isBytes: true, length: 900, last: 255 },
    });
  });

  it("round-trips bytes, and plain objects shaped like the old codec, unchanged", async () => {
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        import { marker } from "ws:test-host";
        export default async () => {
          await fs.writeFile("/workspace/bytes.bin", new Uint8Array([0, 127, 255]));
          const value = await fs.readFile("/workspace/bytes.bin");
          return {
            isBytes: value instanceof Uint8Array,
            bytes: Array.from(value),
            marker: await marker(),
          };
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: {
          isBytes: true,
          bytes: [0, 127, 255],
          marker: {
            __workspace_codec__: { version: 1, type: "bytes", data: [1] },
            keep: true,
          },
        },
      },
    });
  });

  it("exposes caller-supplied env through process.env and hides host env", async () => {
    const response = await runtime({
      source: `
        export default () => ({
          greeting: process.env.GREETING ?? null,
          hasHostSecret: "HOST_SECRET" in process.env,
          keys: Object.keys(process.env).sort(),
        });
      `,
      env: { GREETING: "hello" },
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: {
          greeting: "hello",
          hasHostSecret: false,
          keys: ["GREETING"],
        },
      },
    });
  });

  it("reflects the exec cwd and inert argv/platform on process", async () => {
    const response = await runtime({
      source: `
        export default () => ({
          cwd: process.cwd(),
          argvLength: process.argv.length,
          platform: process.platform,
        });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: { cwd: "/workspace", argvLength: 2, platform: "linux" },
      },
    });
  });

  it("exposes caller-supplied stdin as an async-iterable process.stdin", async () => {
    const response = await runtime({
      source: `
        export default async () => {
          const decoder = new TextDecoder();
          let text = "";
          for await (const chunk of process.stdin) text += decoder.decode(chunk);
          return { text, isTTY: process.stdin.isTTY };
        };
      `,
      stdin: "hello stdin",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: { text: "hello stdin", isTTY: false },
      },
    });
  });

  it("routes console and process.stdout/stderr writes to the right streams", async () => {
    const response = await runtime({
      source: `
        export default () => {
          console.log("log-line");
          console.error("error-line");
          process.stderr.write("raw-err");
          return true;
        };
      `,
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("completed");
    expect(payload.result.stdout).toBe("log-line\n");
    expect(payload.result.stderr).toBe("error-line\nraw-err");
  });

  it("bounds persisted console output including truncation markers and newlines", async () => {
    const response = await runtime({
      source: `export default () => { console.log("🙂".repeat(256)); return true; };`,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("completed");
    expect(new TextEncoder().encode(payload.result.stdout).byteLength).toBeLessThanOrEqual(64);
    expect(payload.result.stdout).toContain("stdio truncated");
  });

  it("bounds oversized host module error responses", async () => {
    const response = await runtime({
      source: `
        import { largeError } from "ws:test-host";
        export default () => largeError();
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("failed");
    expect(new TextEncoder().encode(payload.result.stderr).byteLength).toBeLessThanOrEqual(64);
  });

  it("bounds many small writes by the shared stdio byte ceiling", async () => {
    const response = await runtime({
      source: `export default () => { for (let i = 0; i < 100; i++) console.log("xy"); return true; };`,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("completed");
    expect(new TextEncoder().encode(payload.result.stdout).byteLength).toBeLessThanOrEqual(64);
    expect(payload.result.stdout.split("\n").filter(Boolean).length).toBeLessThan(100);
  });

  it("bounds concurrent host capability calls", async () => {
    const response = await runtime({
      source: `
        import { slow } from "ws:test-host";
        export default async () => {
          const settled = await Promise.allSettled([slow(), slow(), slow()]);
          return settled.map((item) => item.status);
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result.value).toEqual(["fulfilled", "fulfilled", "rejected"]);
  });

  it("rejects non-plain results from host modules", async () => {
    const response = await runtime({
      source: `
        import { invalidResult } from "ws:test-host";
        export default () => invalidResult();
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("plain objects"),
      },
    });
  });

  it("exposes only the functions a host module declares", async () => {
    const response = await runtime({
      source: `
        import * as host from "ws:test-host";
        export default () => Object.keys(host).sort();
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result.value).toEqual([
      "delete",
      "echo",
      "invalidResult",
      "largeError",
      "marker",
      "slow",
      "sum",
    ]);
  });

  it("fails to link an import the host module does not export", async () => {
    const response = await runtime({
      source: `
        import { call } from "ws:test-host";
        export default () => call("echo");
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: { status: "failed", stderr: expect.stringContaining("does not provide an export") },
    });
  });

  it("runs container commands from isolate code through ws:container", async () => {
    const response = await runtime({
      source: `
        import { exec } from "ws:container";
        export default () =>
          exec("npm test", { cwd: "/workspace/app", env: { WHO: "isolate" }, stdin: "y" });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: {
          exitCode: 8,
          stdout: "ran npm test in /workspace/app with isolate and y\n",
          stderr: "warn\n",
        },
      },
    });
  });

  it("rejects a malformed ws:container call inside the isolate", async () => {
    const response = await runtime({
      source: `
        import { exec } from "ws:container";
        export default async () => {
          try {
            await exec("ls", { shell: "zsh" });
            return "ran";
          } catch (error) {
            return error.message;
          }
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result.value).toContain('unknown option "shell"');
  });

  it("rejects a cyclic argument with a clear error", async () => {
    const response = await runtime({
      source: `
        import { echo } from "ws:test-host";
        export default async () => {
          const value = {};
          value.self = value;
          try {
            await echo(value);
            return "sent";
          } catch (error) {
            return error.message;
          }
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result.value, text).toContain("acyclic");
  });

  it("fails a run when a floating promise at module scope rejects", async () => {
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        (async () => {
          await fs.writeFile("/workspace/floating.txt", "never");
        })();
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const { result } = JSON.parse(text);
    expect(result, text).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr, text).toContain("node:fs writeFile can't run at module scope");
  });

  it("fails a run that caught a call refused at module scope", async () => {
    const response = await runtime({
      source: `
        import { echo } from "ws:test-host";
        (async () => {
          try {
            await echo("too early");
          } catch {}
        })();
        export default () => "returned";
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const { result } = JSON.parse(text);
    expect(result, text).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr, text).toContain("ws:test-host echo can't run at module scope");
  });

  it("names the call when top-level await does I/O", async () => {
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        await fs.readdir("/workspace");
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const { result } = JSON.parse(text);
    expect(result, text).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr, text).toContain("node:fs readdir can't run at module scope");
  });

  it("fails a run when a promise the default export left behind rejects", async () => {
    const response = await runtime({
      source: `
        export default async () => {
          Promise.reject(new Error("left behind"));
          return "returned";
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const { result } = JSON.parse(text);
    expect(result, text).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr, text).toContain("left behind");
  });

  it("ignores a rejection the module handles", async () => {
    const response = await runtime({
      source: `
        export default async () => {
          const failing = Promise.reject(new Error("handled"));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return await failing.catch((error) => error.message);
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result, text).toMatchObject({ status: "completed", value: "handled" });
  });

  it("drops undefined fields from a run result, as JSON does", async () => {
    const response = await runtime({
      source: `export default () => ({ kept: 1, dropped: undefined, nested: { also: undefined } });`,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result, text).toMatchObject({
      status: "completed",
      value: { kept: 1, nested: {} },
    });
    expect(JSON.parse(text).result.value).not.toHaveProperty("dropped");
  });

  it("does not expose unrestricted host operations through the node:fs dispatcher", async () => {
    const response = await runtime({
      source: `
        export default async function () {
          const call = globalThis[Symbol.for("cloudflare.workspace.runtime.call")];
          return call("fs", "find", ["/workspace"]);
        }
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("internal Workspace filesystem dispatcher"),
      },
    });
  });

  it("preserves supported node:fs write and relative-symlink semantics", async () => {
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        export default async function () {
          await fs.mkdir("/workspace/links", { recursive: true });
          await fs.writeFile("/workspace/target.txt", "target");
          await fs.symlink("../target.txt", "/workspace/links/target");
          let exclusive;
          try { await fs.writeFile("/workspace/target.txt", "overwrite", { flag: "wx" }); }
          catch (error) { exclusive = error.code; }
          let missingParent;
          try { await fs.writeFile("/workspace/missing/file.txt", "nope"); }
          catch (error) { missingParent = error.code; }
          let unsupportedEncoding;
          try { await fs.readFile("/workspace/target.txt", "base64"); }
          catch (error) { unsupportedEncoding = error.message; }
          return {
            exclusive,
            missingParent,
            unsupportedEncoding,
            link: await fs.readlink("/workspace/links/target"),
            isLink: (await fs.lstat("/workspace/links/target")).isSymbolicLink(),
          };
        }
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "completed",
        value: {
          exclusive: "EEXIST",
          missingParent: "ENOENT",
          unsupportedEncoding: expect.stringContaining("supports only utf8"),
          link: "../target.txt",
          isLink: true,
        },
      },
    });
  });

  it("confines ws:git operations to the backend root", async () => {
    const response = await runtime({
      source: `
        import { status } from "ws:git";
        export default () => status({ dir: "/" });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("must stay under /workspace"),
      },
    });
  });

  it("confines a leading Git CLI -C to the runtime root", async () => {
    const response = await runtime({
      source: `
        import { cli } from "ws:git";
        export default () => cli({ cwd: "/workspace", argv: ["-C", "/outside", "status"] });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("must stay under /workspace"),
      },
    });
  });

  it("runs a Git CLI command in a leading -C directory", async () => {
    const response = await runtime({
      source: `
        import { cli } from "ws:git";
        export default async () => {
          await cli({ cwd: "/workspace", argv: ["init", "c-repo"] });
          return cli({ cwd: "/workspace", argv: ["-C", "c-repo", "rev-parse", "--show-toplevel"] });
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result, text).toMatchObject({
      status: "completed",
      value: { exitCode: 0, stdout: expect.stringContaining("/workspace/c-repo") },
    });
  });

  it("rejects Git CLI path overrides after the subcommand", async () => {
    const response = await runtime({
      source: `
        import { cli } from "ws:git";
        export default () => cli({ cwd: "/workspace", argv: ["status", "--git-dir=/outside"] });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("path overrides are not available"),
      },
    });
  });

  it("denies host-side Artifact import authority by default", async () => {
    const response = await runtime({
      source: `
        import { importArtifact } from "ws:artifacts";
        export default () => importArtifact("repo", { url: "https://example.com/repo.git" });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("createArtifactsModule"),
      },
    });
  });

  it("denies host-side Git network authority by default", async () => {
    const response = await runtime({
      source: `
        import { clone } from "ws:git";
        export default () => clone({ url: "https://example.com/repository.git", dir: "/workspace/repository" });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text), text).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("createGitModule"),
      },
    });
  });

  it("rejects ws:git paths that traverse a symlink", async () => {
    await write("/outside/repository/README.md", "outside");
    await symlink("/outside/repository", "/workspace/linked-repository");
    const response = await runtime({
      source: `
        import { status } from "ws:git";
        export default () => status({ dir: "/workspace/linked-repository" });
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      result: {
        status: "failed",
        stderr: expect.stringContaining("cannot traverse symbolic link"),
      },
    });
  });

  it("loads transitive durable relative modules", async () => {
    await write("/workspace/lib/math.js", "export const add = (a, b) => a + b;");
    await write(
      "/workspace/task.js",
      `
        import { add } from "./lib/math.js";
        import { writeFile } from "node:fs/promises";
        export default async function task(input) {
          const value = add(input.a, input.b);
          await writeFile("/workspace/module-result.txt", String(value));
          return value;
        }
      `,
    );
    const response = await runtime({
      source: `import task from "./task.js"; export default task;`,
      value: { a: 2, b: 5 },
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ result: { value: 7 } });
    expect(await read("/workspace/module-result.txt")).toBe("7");
  });

  it("bounds thrown errors before transport and persistence", async () => {
    const response = await runtime({
      source: `export default () => { throw new Error("🙂".repeat(1024)); };`,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("failed");
    expect(new TextEncoder().encode(payload.result.stderr).byteLength).toBeLessThanOrEqual(64);
  });

  it("supports start, kill, get, tail result, and dispose for isolate execution", async () => {
    const id = `managed-${crypto.randomUUID()}`;
    const start = await SELF.fetch("https://example.test/runtime-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        source: `export default async function () { await new Promise((resolve) => setTimeout(resolve, 10000)); }`,
      }),
    });
    expect(start.status).toBe(200);
    const killed = await SELF.fetch(
      `https://example.test/runtime-kill?id=${encodeURIComponent(id)}`,
      { method: "POST" },
    );
    expect(killed.status).toBe(204);
    const result = await SELF.fetch(
      `https://example.test/runtime-get?id=${encodeURIComponent(id)}`,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: "cancelled",
      exitCode: 130,
    });
    const tail = await SELF.fetch(
      `https://example.test/runtime-get?id=${encodeURIComponent(id)}&resume=tail`,
    );
    expect(tail.status).toBe(200);
    expect(await tail.json()).toMatchObject({ status: "cancelled", exitCode: 130 });
    const disposed = await SELF.fetch(
      `https://example.test/runtime-dispose?id=${encodeURIComponent(id)}`,
      { method: "POST" },
    );
    expect(disposed.status).toBe(204);
    const missing = await SELF.fetch(
      `https://example.test/runtime-get?id=${encodeURIComponent(id)}`,
    );
    expect(missing.status).toBe(400);
  });
});

// The Worker Loader resolves import specifiers differently under its
// legacy and new module registries, so each case runs on both.
describe.each([
  ["the legacy module registry", "worker-javascript"],
  ["the new module registry", "worker-javascript-new-registry"],
])("module resolution on %s", (_label, backend) => {
  async function run(source: string, cwd = "/workspace/app") {
    const response = await runtime({ source, cwd, backend });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return (JSON.parse(text) as { result: { status: string; value?: unknown; stderr?: string } })
      .result;
  }

  it("resolves bare, relative, and absolute imports from nested directories", async () => {
    await write(
      "/workspace/app/lib/util.js",
      `import { double } from "math-kit";
       import { echo } from "ws:test-host";
       import { shared } from "/workspace/shared/abs.js";
       export const fromNested = async () => ({ doubled: double(2), echoed: await echo("nested"), shared });`,
    );
    await write("/workspace/shared/abs.js", `export const shared = "absolute";`);

    const result = await run(`
      import { double } from "math-kit";
      import { echo } from "ws:test-host";
      import { fromNested } from "./lib/util.js";
      import { shared } from "/workspace/shared/abs.js";
      const lazy = await import("/workspace/shared/abs.js");
      export default async () => ({
        doubled: double(1),
        echoed: await echo("entry"),
        nested: await fromNested(),
        shared,
        lazy: lazy.shared,
      });
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: {
        doubled: 2,
        echoed: { args: ["entry"] },
        nested: { doubled: 4, echoed: { args: ["nested"] }, shared: "absolute" },
        shared: "absolute",
        lazy: "absolute",
      },
    });
  });

  it("shares one instance of a configured module across directories", async () => {
    await write(
      "/workspace/app/deep/er/bump.js",
      `import { bump } from "counter"; export const again = () => bump();`,
    );
    const result = await run(`
      import { bump } from "counter";
      import { again } from "./deep/er/bump.js";
      export default () => { bump(); return again(); };
    `);
    expect(result).toMatchObject({ status: "completed", value: 2 });
  });

  it("names a module as it was written when linking fails", async () => {
    const result = await run(`import { missing } from "math-kit"; export default missing;`);
    expect(result).toMatchObject({
      status: "failed",
      stderr: expect.stringContaining("'math-kit'"),
    });
    expect(result).not.toMatchObject({ stderr: expect.stringContaining("__modules__") });
  });

  it("lets a configured module import other configured and host modules", async () => {
    const result = await run(`
      import { both } from "facade";
      export default () => both(3);
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { doubled: 6, echoed: { args: [3] } },
    });
  });
});
