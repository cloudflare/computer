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

  it("executes an ES module with configured and trusted modules", async () => {
    const response = await runtime({
      source: `
        import { double } from "math-kit";
        import fs from "node:fs/promises";
        import { promises as nodeFs } from "node:fs";
        import * as git from "ws:git";
        import { call } from "ws:test-host";
        export default async function main(input) {
          const value = double(input.value);
          await fs.writeFile("/workspace/runtime-result.txt", String(value));
          const initialized = await git.cli({ argv: ["init"], cwd: "/workspace/repository" });
          return {
            value,
            persisted: await fs.readFile("/workspace/runtime-result.txt", "utf8"),
            gitExitCode: initialized.exitCode,
            trusted: await call("echo", input.value),
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
          trusted: { method: "echo", args: [21] },
          nodeFs: {
            isFile: true,
            entries: expect.arrayContaining(["runtime-result.txt"]),
          },
        },
      },
    });
  });

  it("round-trips bytes and marker-shaped plain objects without codec collisions", async () => {
    const response = await runtime({
      source: `
        import fs from "node:fs/promises";
        import { call } from "ws:test-host";
        export default async () => {
          await fs.writeFile("/workspace/bytes.bin", new Uint8Array([0, 127, 255]));
          const value = await fs.readFile("/workspace/bytes.bin");
          return {
            isBytes: value instanceof Uint8Array,
            bytes: Array.from(value),
            marker: await call("marker"),
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
    expect(payload.result.stdout).toContain("logs truncated");
  });

  it("bounds oversized trusted-module error responses", async () => {
    const response = await runtime({
      source: `
        import { call } from "ws:test-host";
        export default () => call("large-error");
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.status).toBe("failed");
    expect(new TextEncoder().encode(payload.result.stderr).byteLength).toBeLessThanOrEqual(64);
  });

  it("bounds log event amplification independently of log bytes", async () => {
    const response = await runtime({
      source: `export default () => { for (let i = 0; i < 20; i++) console.log(""); return true; };`,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text);
    expect(payload.result.stdout.split("\n").filter(Boolean)).toEqual(["...[logs truncated]"]);
    expect(payload.result.stdout.split("\n").length - 1).toBe(3);
  });

  it("bounds concurrent host capability calls", async () => {
    const response = await runtime({
      source: `
        import { call } from "ws:test-host";
        export default async () => {
          const settled = await Promise.allSettled([call("slow"), call("slow"), call("slow")]);
          return settled.map((item) => item.status);
        };
      `,
      cwd: "/workspace",
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text).result.value).toEqual(["fulfilled", "fulfilled", "rejected"]);
  });

  it("rejects non-plain results from host trusted modules", async () => {
    const response = await runtime({
      source: `
        import { call } from "ws:test-host";
        export default () => call("invalid-result");
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

  it("confines trusted Git operations to the backend root", async () => {
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

  it("rejects Git CLI path overrides that bypass the runtime root", async () => {
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
        stderr: expect.stringContaining("allowArtifac"),
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
        stderr: expect.stringContaining("allowGitNetwork"),
      },
    });
  });

  it("rejects trusted Git paths that traverse a symlink", async () => {
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
