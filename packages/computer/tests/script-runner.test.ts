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
      "gate",
      "hold",
      "invalidResult",
      "largeError",
      "marker",
      "slow",
      "sum",
      "tick",
      "unsafeGate",
      "wait",
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
        export default () => "returned";
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
        export default () => "returned";
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

  it("creates its root in a fresh Workspace", async () => {
    const response = await SELF.fetch(
      `https://example.test/runtime?object=${crypto.randomUUID()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: `
            import fs from "node:fs/promises";
            export default async () => {
              await fs.writeFile("/workspace/first.txt", "written");
              return await fs.readdir("/workspace");
            };
          `,
        }),
      },
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result, text).toMatchObject({
      status: "completed",
      value: ["first.txt"],
    });
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

  it("runs Node.js built-ins the runtime provides, by node: or bare name", async () => {
    const result = await run(`
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      import { gzipSync, gunzipSync } from "node:zlib";
      import path from "path";
      export default () => ({
        joined: join("/workspace", "a", "..", "b.txt"),
        bare: path.basename("/workspace/c.txt"),
        sha: createHash("sha256").update("abc").digest("hex").slice(0, 8),
        zipped: gunzipSync(gzipSync("round trip")).toString(),
      });
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { joined: "/workspace/b.txt", bare: "c.txt", sha: "ba7816bf", zipped: "round trip" },
    });
  });

  it("runs a default export re-exported from a workspace file", async () => {
    await write(
      "/workspace/app/main.js",
      `import fs from "node:fs/promises";
      export default async (input) => {
        await fs.writeFile("/workspace/app/out.txt", String(input.n * 21));
        return fs.readFile("/workspace/app/out.txt", "utf8");
      };`,
    );
    const response = await runtime({
      source: `export { default } from "./main.js";`,
      cwd: "/workspace/app",
      backend,
      value: { n: 2 },
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ result: { status: "completed", value: "42" } });
  });

  it("runs the Node.js timer, async context, and diagnostics built-ins", async () => {
    const result = await run(`
      import { setTimeout as fire } from "node:timers";
      import { setTimeout as sleep } from "node:timers/promises";
      import { AsyncLocalStorage } from "node:async_hooks";
      import diagnostics from "node:diagnostics_channel";
      export default async () => {
        const fired = await new Promise((resolve) => fire(() => resolve("fired"), 1));
        const slept = await sleep(1, "slept");
        const storage = new AsyncLocalStorage();
        const stored = await storage.run(7, async () => {
          await sleep(1);
          return storage.getStore();
        });
        const channel = diagnostics.channel("probe");
        let published;
        channel.subscribe((message) => {
          published = message;
        });
        channel.publish("sent");
        return { fired, slept, stored, published };
      };
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { fired: "fired", slept: "slept", stored: 7, published: "sent" },
    });
  });

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

describe("durable executions", () => {
  const source = `
    import fs from "node:fs/promises";
    import { tick, gate } from "ws:test-host";
    export default async function () {
      const roll = Math.random();
      console.log("a");
      await fs.writeFile("/workspace/roll.txt", String(roll));
      const first = await tick("work");
      await gate();
      console.log("b");
      const second = await tick("work");
      return { roll, saved: await fs.readFile("/workspace/roll.txt", "utf8"), first, second };
    }
  `;

  async function start(
    id: string,
    body: { source: string; onInterrupt?: string; network?: boolean },
  ) {
    const response = await SELF.fetch("https://example.test/durable-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await SELF.fetch("https://example.test/durable-restart", { method: "POST" });
  }

  async function result(id: string, options: { network?: boolean } = {}) {
    const response = await SELF.fetch(
      `https://example.test/runtime-get?id=${encodeURIComponent(id)}${options.network === true ? "&network" : ""}`,
    );
    return (await response.json()) as {
      status: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      value?: unknown;
    };
  }

  async function calls() {
    return (await (await SELF.fetch("https://example.test/durable-calls")).json()) as Record<
      string,
      number
    >;
  }

  it("replays a run after a restart without repeating its calls or output", async () => {
    await start("durable-replay", { source, onInterrupt: "replay" });
    const settled = await result("durable-replay");
    expect(settled).toMatchObject({ status: "completed", exitCode: 0, stdout: "a\nb\n" });
    const value = settled.value as { roll: number; saved: string; first: number; second: number };
    expect(value.saved).toBe(String(value.roll));
    expect(value).toMatchObject({ first: 1, second: 2 });
    // The first tick came from the journal. The gate was in flight, so
    // it ran again.
    expect(await calls()).toEqual({ work: 2, gate: 2 });
  });

  it("replays the clock a run read before it was interrupted", async () => {
    await start("durable-clock", {
      source: `
        import fs from "node:fs/promises";
        import { gate, tick } from "ws:test-host";
        export default async function () {
          const started = Date.now();
          await fs.writeFile("/workspace/clock.txt", String(started));
          await new Promise((resolve) => setTimeout(resolve, 5));
          const slept = new Date().getTime();
          await tick(slept - started >= 5 ? "slept" : "early");
          await gate();
          return { started, slept, later: Date.now() >= slept };
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-clock");
    expect(settled, settled.stderr).toMatchObject({
      status: "completed",
      value: { later: true },
    });
    expect(await calls()).toEqual({ slept: 1, gate: 2 });
  });

  it("doesn't wait out a replayed run's sleeps again", async () => {
    await start("durable-sleep", {
      source: `
        import { gate, tick } from "ws:test-host";
        export default async function () {
          const started = Date.now();
          for (let index = 0; index < 3; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await tick("slept");
          }
          await gate();
          return Date.now() - started;
        }
      `,
      onInterrupt: "replay",
    });
    const resumed = Date.now();
    const settled = await result("durable-sleep");
    expect(Date.now() - resumed).toBeLessThan(1000);
    // The clock still counts the sleeps.
    expect(settled).toMatchObject({ status: "completed" });
    expect(settled.value).toBeGreaterThanOrEqual(3000);
    expect(await calls()).toEqual({ slept: 3, gate: 2 });
  });

  it("restarts a run from the beginning", async () => {
    await start("durable-restart", { source, onInterrupt: "restart" });
    const settled = await result("durable-restart");
    expect(settled).toMatchObject({ status: "completed", stdout: "a\na\nb\n" });
    expect(settled.stderr).toContain("restarted from the beginning");
    expect(settled.value).toMatchObject({ first: 2, second: 3 });
    expect(await calls()).toEqual({ work: 3, gate: 2 });
  });

  it("fails a replay that takes a different path", async () => {
    await start("durable-diverge", {
      source: `
        import fs from "node:fs/promises";
        import { gate, tick } from "ws:test-host";
        export default async function () {
          // Generated keys are the one source of randomness a replay
          // doesn't repeat.
          const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
          const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
          await fs.writeFile("/workspace/" + raw.slice(0, 8).join("-") + ".txt", "x");
          await gate();
          await tick("after");
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-diverge");
    expect(settled).toMatchObject({ status: "failed", exitCode: 1 });
    expect(settled.stderr).toContain("took a different path");
    expect(await calls()).toEqual({ gate: 1 });
  });

  it("repeats a run's random numbers when it replays", async () => {
    await start("durable-random", {
      source: `
        import { gate } from "ws:test-host";
        export default async function () {
          // Short enough to stay under the test backend's output limit.
          const values = [
            Math.random().toFixed(8),
            crypto.randomUUID().slice(0, 13),
            crypto.getRandomValues(new Uint8Array(4)).join(","),
          ];
          console.log(values.join(" "));
          await gate();
          return values;
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-random");
    // The replay checks the line it prints against the one recorded, and
    // would fail on a different one.
    expect(settled).toMatchObject({ status: "completed", exitCode: 0 });
    expect(settled.stdout).toBe(`${(settled.value as string[]).join(" ")}\n`);
  });

  it("delivers replayed responses in the order they first arrived", async () => {
    await start("durable-order", {
      source: `
        import { gate, wait } from "ws:test-host";
        export default async function () {
          const slow = wait(80, "slow").then(() => "slow");
          const fast = wait(5, "fast").then(() => "fast");
          const winner = await Promise.race([slow, fast]);
          await Promise.all([slow, fast]);
          console.log(winner);
          await gate();
          return winner;
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-order");
    expect(settled).toMatchObject({ status: "completed", stdout: "fast\n", value: "fast" });
    expect(await calls()).toEqual({ slow: 1, fast: 1, gate: 2 });
  });

  it("fires replayed timers in order with replayed responses", async () => {
    await start("durable-race", {
      source: `
        import { gate, wait } from "ws:test-host";
        // unref() checks the timers hand back the same kind of handle as
        // the runtime's own.
        const sleep = (ms, value) =>
          new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
        export default async function () {
          const long = wait(150, "long");
          const first = await Promise.race([sleep(20, "timer"), long.then(() => "call")]);
          await long;
          const short = wait(5, "short");
          const second = await Promise.race([sleep(150, "timer"), short.then(() => "call")]);
          console.log(first, second);
          await gate();
          return [first, second];
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-race");
    expect(settled).toMatchObject({ status: "completed", stdout: "timer call\n" });
    expect(await calls()).toEqual({ long: 1, short: 1, gate: 2 });
  });

  it("keeps the live order when the run computes between events", async () => {
    await start("durable-compute", {
      source: `
        import { gate, wait } from "ws:test-host";
        const sleep = (ms, value) => new Promise((resolve) => setTimeout(resolve, ms));
        export default async function () {
          // The clock doesn't move while code computes, so the timer is
          // due earlier by the clock than it fires in fact.
          let x = 0;
          for (let i = 0; i < 1e9; i++) x ^= i;
          const call = wait(100, "call").then(() => "call");
          const winner = await Promise.race([sleep(300, "timer"), call]);
          await call;
          console.log(winner, x > -1);
          await gate();
          return winner;
        }
      `,
      onInterrupt: "replay",
    });
    const settled = await result("durable-compute");
    expect(settled).toMatchObject({ status: "completed", stdout: "call true\n", value: "call" });
  });

  it("journals fetch so a replay doesn't send it again", async () => {
    await start("durable-fetch", {
      source: `
        import { gate } from "ws:test-host";
        export default async function () {
          const response = await fetch("https://gateway.test/items", { method: "POST", body: "hi" });
          const text = await response.text();
          console.log(response.status, response.headers.get("x-count"), text);
          await gate();
          return text;
        }
      `,
      onInterrupt: "replay",
      network: true,
    });
    const settled = await result("durable-fetch", { network: true });
    expect(settled).toMatchObject({
      status: "completed",
      stdout: "200 1 POST /items hi #1\n",
      value: "POST /items hi #1",
    });
    expect(await calls()).toEqual({ fetch: 1, gate: 2 });
  });

  it("doesn't count a replayable run's fetches toward its capability calls", async () => {
    await start("durable-many-fetches", {
      source: `
        import { gate } from "ws:test-host";
        export default async function () {
          // More than the default 256 capability calls, a dozen at a time.
          for (let round = 0; round < 25; round++) {
            await Promise.all(Array.from({ length: 12 }, () => fetch("https://gateway.test/x")));
          }
          await gate();
          return "done";
        }
      `,
      onInterrupt: "replay",
      network: true,
    });
    const settled = await result("durable-many-fetches", { network: true });
    expect(settled).toMatchObject({ status: "completed", value: "done" });
    expect(await calls()).toEqual({ fetch: 300, gate: 2 });
  });

  it("fails a replay that prints different output", async () => {
    await start("durable-output", {
      source: `
        import { gate } from "ws:test-host";
        export default async function () {
          const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
          console.log(new Uint8Array(await crypto.subtle.exportKey("raw", key)).slice(0, 8).join(","));
          await gate();
        }
      `,
      onInterrupt: "replay",
      // This backend's output limit leaves the whole message.
      network: true,
    });
    const settled = await result("durable-output", { network: true });
    expect(settled).toMatchObject({ status: "failed", exitCode: 1 });
    expect(settled.stderr).toContain("it wrote different stdout from the first time");
  });

  it("fails a replay interrupted during a call that isn't safe to repeat", async () => {
    await start("durable-unsafe", {
      source: `
        import { unsafeGate } from "ws:test-host";
        export default async function () {
          await unsafeGate();
        }
      `,
      onInterrupt: "replay",
      network: true,
    });
    const settled = await result("durable-unsafe", { network: true });
    expect(settled).toMatchObject({ status: "failed", exitCode: 1 });
    expect(settled.stderr).toContain(
      "interrupted while ws:test-host.unsafeGate was running, which isn't safe to repeat",
    );
    expect(await calls()).toEqual({ gate: 1 });
  });

  it("replays a run interrupted a second time during its replay", async () => {
    await start("durable-twice", {
      source: `
        import { gate, hold, tick } from "ws:test-host";
        export default async function () {
          console.log("one", await tick("a"));
          await gate();
          console.log("two", await tick("b"));
          await hold("second");
          console.log("three", await tick("c"));
          return Math.random();
        }
      `,
      onInterrupt: "replay",
    });
    // Resume the run, and wait for it to reach the second hold.
    await SELF.fetch("https://example.test/durable-recover", { method: "POST" });
    for (let attempt = 0; attempt < 100 && (await calls()).second !== 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await SELF.fetch("https://example.test/durable-restart?open=second", { method: "POST" });
    const settled = await result("durable-twice");
    expect(settled).toMatchObject({ status: "completed", stdout: "one 1\ntwo 1\nthree 1\n" });
    // Each tick ran once. The gate and the hold were each in flight at an
    // interruption, so each ran again once.
    expect(await calls()).toEqual({ a: 1, gate: 2, b: 1, second: 2, c: 1 });
  });

  it("fails an interrupted run by default", async () => {
    await start("durable-fail", { source });
    const settled = await result("durable-fail");
    expect(settled).toMatchObject({ status: "failed", exitCode: 1 });
    expect(settled.stderr).toContain("interrupted when its Workspace runtime restarted");
  });

  it("resumes runs when the host calls recover", async () => {
    await start("durable-recover", { source, onInterrupt: "replay" });
    await SELF.fetch("https://example.test/durable-recover", { method: "POST" });
    for (let attempt = 0; attempt < 100 && (await calls()).work !== 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await calls()).toEqual({ work: 2, gate: 2 });
    expect(await result("durable-recover")).toMatchObject({ status: "completed" });
  });
});
