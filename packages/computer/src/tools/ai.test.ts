import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import type { ExecHandle, ExecResult } from "../shell.js";
import { Workspace } from "../workspace.js";
import {
  createAITools,
  createEditTool,
  createReadTool,
  createWriteTool,
  type FileStore,
  WorkspaceFileStore,
} from "./index.js";

const toolOptions = { toolCallId: "test-call", messages: [] };

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown, options: typeof toolOptions) => unknown })
    .execute;
  if (!execute) throw new Error("tool has no execute function");
  return await execute(input, toolOptions);
}

function toolDescription(tool: unknown): string {
  const description = (tool as { description?: unknown }).description;
  if (typeof description !== "string") throw new Error("tool has no description");
  return description;
}

function makeWorkspace(): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), now: () => 1_700_000_000_000 });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

async function drainChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function memoryStore(options: {
  content?: string;
  mode?: number;
  size?: number;
  statError?: Error;
  readError?: Error;
  writeError?: Error;
  onWrite?: (path: string, content: Uint8Array, opts?: { mode?: number }) => void;
}): FileStore {
  const content = options.content ?? "";
  return {
    async stat() {
      if (options.statError) throw options.statError;
      return {
        size: options.size ?? bytes(content).byteLength,
        mtime: 1,
        mode: options.mode,
      };
    },
    async readAll() {
      if (options.readError) throw options.readError;
      return bytes(content);
    },
    async *readChunks() {
      if (options.readError) throw options.readError;
      yield bytes(content);
    },
    async write(path, nextContent, opts) {
      if (options.writeError) throw options.writeError;
      options.onWrite?.(path, nextContent, opts);
    },
  };
}

describe("WorkspaceFileStore", () => {
  it("slices byte ranges while reading chunks from Workspace.fs", async () => {
    const workspace = makeWorkspace();
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/range.txt", bytes("abcdefghij"));
    const store = new WorkspaceFileStore(workspace);

    await expect(
      drainChunks(store.readChunks("/workspace/range.txt", 2, 5)).then(decode),
    ).resolves.toBe("cdefg");
  });

  it("cancels read streams when a byte range stops before EOF", async () => {
    let cancelled = false;
    const workspace = {
      fs: {
        async stat() {
          return { size: 10, mtime: 1, mode: 0o100644, isFile: true, isDirectory: false };
        },
        async readFile() {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes("abcdefghij"));
            },
            cancel() {
              cancelled = true;
            },
          });
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
        async readdir() {
          return [];
        },
      },
    };
    const store = new WorkspaceFileStore(workspace);

    await expect(
      drainChunks(store.readChunks("/workspace/range.txt", 2, 5)).then(decode),
    ).resolves.toBe("cdefg");
    expect(cancelled).toBe(true);
  });
});

describe("createAITools filesystem tools", () => {
  it("creates fixed read, write, edit, and ls tools by default", () => {
    const tools = createAITools({ workspace: makeWorkspace() });

    expect(Object.keys(tools).sort()).toEqual(["edit", "ls", "read", "write"]);
  });

  it("returns only read-only tools when readonly is true", () => {
    const tools = createAITools({
      workspace: makeWorkspace(),
      readonly: true,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "test shell" } },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["ls", "read"]);
  });

  it("reads, lists, writes, and edits workspace files", async () => {
    const workspace = makeWorkspace();
    const tools = createAITools({ workspace });

    await executeTool(tools.write, { path: "/workspace/notes/todo.txt", content: "one\ntwo\n" });

    await expect(workspace.fs.readFile("/workspace/notes/todo.txt", "utf8")).resolves.toBe(
      "one\ntwo\n",
    );
    await expect(executeTool(tools.ls, { path: "/workspace/notes" })).resolves.toEqual({
      path: "/workspace/notes",
      entries: [{ name: "todo.txt", isFile: true, isDirectory: false }],
    });
    await expect(
      executeTool(tools.read, { path: "/workspace/notes/todo.txt", limit: 1 }),
    ).resolves.toMatchObject({
      path: "/workspace/notes/todo.txt",
      content: "one",
      startLine: 1,
      endLine: 1,
      truncated: true,
      nextOffset: 2,
    });

    await expect(
      executeTool(tools.edit, {
        path: "/workspace/notes/todo.txt",
        edits: [{ oldText: "two", newText: "three" }],
      }),
    ).resolves.toMatchObject({ path: "/workspace/notes/todo.txt", editsApplied: 1 });
    await expect(workspace.fs.readFile("/workspace/notes/todo.txt", "utf8")).resolves.toBe(
      "one\nthree\n",
    );
  });

  it("preserves file mode when write overwrites an existing file", async () => {
    const writes: Array<{ path: string; content: string; mode?: number }> = [];
    const tool = createWriteTool({
      store: memoryStore({
        content: "old",
        mode: 0o100755,
        onWrite(path, content, opts) {
          writes.push({ path, content: decode(content), mode: opts?.mode });
        },
      }),
    });

    await expect(
      executeTool(tool, { path: "/workspace/script.sh", content: "new" }),
    ).resolves.toEqual({ path: "/workspace/script.sh", bytesWritten: 3 });
    expect(writes).toEqual([{ path: "/workspace/script.sh", content: "new", mode: 0o100755 }]);
  });

  it("returns structured write errors for filesystem failures", async () => {
    const tool = createWriteTool({
      store: memoryStore({ content: "old", writeError: new Error("disk full") }),
    });

    await expect(
      executeTool(tool, { path: "/workspace/out.txt", content: "new" }),
    ).resolves.toEqual({ error: "disk full" });
  });

  it("rejects writes over the byte cap", async () => {
    const tool = createWriteTool({ store: memoryStore({}), maxBytes: 3 });

    await expect(
      executeTool(tool, { path: "/workspace/out.txt", content: "abcd" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("exceeds the 3-byte write cap") });
  });

  it("returns structured edit errors for non-unique replacements", async () => {
    const tool = createEditTool({ store: memoryStore({ content: "same\nsame\n" }) });

    await expect(
      executeTool(tool, {
        path: "/workspace/file.txt",
        edits: [{ oldText: "same", newText: "different" }],
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("must be unique") });
  });

  it("returns structured edit errors for filesystem failures", async () => {
    const tool = createEditTool({
      store: memoryStore({ content: "old", writeError: new Error("read-only filesystem") }),
    });

    await expect(
      executeTool(tool, {
        path: "/workspace/file.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ).resolves.toEqual({ error: "read-only filesystem" });
  });

  it("rejects edits for files over the byte cap", async () => {
    const tool = createEditTool({ store: memoryStore({ content: "old", size: 10 }), maxBytes: 3 });

    await expect(
      executeTool(tool, {
        path: "/workspace/file.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("exceeds the 3-byte cap") });
  });

  it("caps large reads and reports first-line overflow", async () => {
    const tool = createReadTool({ store: memoryStore({ content: "abcdef\n" }), maxBytes: 3 });

    await expect(executeTool(tool, { path: "/workspace/file.txt" })).resolves.toEqual({
      error:
        "Line 1 exceeds the 3-byte read cap. Increase the cap or read a narrower range with offset/limit.",
    });
  });
});

describe("createAITools exec tool", () => {
  it("adds exec only when shell options are provided", () => {
    const workspace = makeWorkspace();

    expect(createAITools({ workspace }).exec).toBeUndefined();
    expect(
      createAITools({
        workspace,
        shell: {
          defaultBackend: "shell",
          backends: { shell: { description: "test shell" } },
        },
      }).exec,
    ).toBeDefined();
  });

  it("runs shell commands on the selected backend and truncates output", async () => {
    const calls: Array<{ command: string; cwd: string | undefined; backend: string | undefined }> =
      [];
    const workspace = {
      shell: {
        async exec(command: string, options: { cwd?: string; encoding: "utf8"; backend?: string }) {
          calls.push({ command, cwd: options.cwd, backend: options.backend });
          const result: ExecResult<"utf8"> = {
            exitCode: 2,
            stdout: "abcdef",
            stderr: "uvwxyz",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as ExecHandle<"utf8">;
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: { description: "fast shell" },
          container: { description: "full Linux" },
        },
        maxBytes: 3,
      },
    });

    await expect(
      executeTool(tools.exec, { command: "npm test", cwd: "/workspace", backend: "container" }),
    ).resolves.toEqual({
      command: "npm test",
      cwd: "/workspace",
      backend: "container",
      exitCode: 2,
      stdout: "abc\n\n[truncated, 3 more bytes]",
      stderr: "uvw\n\n[truncated, 3 more bytes]",
    });
    expect(calls).toEqual([{ command: "npm test", cwd: "/workspace", backend: "container" }]);
  });

  it("truncates exec output on UTF-8 byte boundaries", async () => {
    const workspace = {
      shell: {
        async exec() {
          const result: ExecResult<"utf8"> = {
            exitCode: 0,
            stdout: "a🙂b",
            stderr: "🙂🙂",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as ExecHandle<"utf8">;
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
        maxBytes: 5,
      },
    });

    await expect(executeTool(tools.exec, { command: "echo emoji" })).resolves.toMatchObject({
      stdout: "a🙂\n\n[truncated, 1 more bytes]",
      stderr: "🙂\n\n[truncated, 4 more bytes]",
    });
  });

  it("routes omitted backend to defaultBackend", async () => {
    const calls: Array<{ command: string; backend: string | undefined }> = [];
    const workspace = {
      shell: {
        async exec(command: string, options: { encoding: "utf8"; backend?: string }) {
          calls.push({ command, backend: options.backend });
          const result: ExecResult<"utf8"> = {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as ExecHandle<"utf8">;
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
      },
    });

    await expect(executeTool(tools.exec, { command: "echo ok" })).resolves.toMatchObject({
      backend: "shell",
      exitCode: 0,
    });
    expect(calls).toEqual([{ command: "echo ok", backend: "shell" }]);
  });

  it("tells the model to retry on a capable backend after command-not-found errors", () => {
    const workspace = {
      shell: {
        async exec() {
          throw new Error("not used");
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: { description: "fast shell with a limited built-in command set" },
          container: { description: "full Linux userland with npm and node" },
        },
      },
    });

    expect(toolDescription(tools.exec)).toContain("command not found");
    expect(toolDescription(tools.exec)).toContain("retry on a backend whose description covers");
  });

  it("returns structured exec errors", async () => {
    const workspace = {
      shell: {
        async exec() {
          throw new Error("backend unavailable");
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
      },
    });

    await expect(executeTool(tools.exec, { command: "npm test" })).resolves.toEqual({
      command: "npm test",
      cwd: null,
      backend: "shell",
      error: "backend unavailable",
    });
  });

  it("returns structured exec result errors", async () => {
    const workspace = {
      shell: {
        async exec() {
          return {
            async result() {
              throw new Error("transport closed");
            },
          };
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
      },
    });

    await expect(executeTool(tools.exec, { command: "npm test" })).resolves.toEqual({
      command: "npm test",
      cwd: null,
      backend: "shell",
      error: "transport closed",
    });
  });

  it("rejects invalid shell backend configuration", () => {
    const workspace = makeWorkspace();

    expect(() =>
      createAITools({
        workspace,
        shell: { defaultBackend: "missing", backends: { shell: { description: "test" } } },
      }),
    ).toThrow(/defaultBackend/);
  });
});

describe("createAITools publish tool", () => {
  it("adds publish by default when assets are configured", async () => {
    const calls: Array<{ path: string; expiresAfter: number; prefix?: string }> = [];
    const workspace = {
      fs: makeWorkspace().fs,
      sessionId: "session-a",
      assets: {
        async share(path: string, opts: { expiresAfter: number; prefix?: string }) {
          calls.push({ path, ...opts });
          return "https://example.test/report.html";
        },
      },
    };
    const tools = createAITools({ workspace });

    expect(tools.publish).toBeDefined();
    await expect(
      executeTool(tools.publish, { path: "/workspace/out/report.html", expiresAfterMs: 1234 }),
    ).resolves.toEqual({ ok: true, url: "https://example.test/report.html" });
    expect(calls).toEqual([
      { path: "/workspace/out/report.html", expiresAfter: 1234, prefix: "agent-session-a" },
    ]);
  });

  it("omits the publish prefix when sessionId is empty", async () => {
    const calls: Array<{ path: string; expiresAfter: number; prefix?: string }> = [];
    const workspace = {
      fs: makeWorkspace().fs,
      sessionId: "",
      assets: {
        async share(path: string, opts: { expiresAfter: number; prefix?: string }) {
          calls.push({ path, ...opts });
          return "https://example.test/report.html";
        },
      },
    };
    const tools = createAITools({ workspace });

    await expect(
      executeTool(tools.publish, { path: "/workspace/out/report.html" }),
    ).resolves.toEqual({
      ok: true,
      url: "https://example.test/report.html",
    });
    expect(calls).toEqual([{ path: "/workspace/out/report.html", expiresAfter: 60 * 60 * 1000 }]);
  });

  it("omits publish when assets are disabled or readonly is true", () => {
    const workspace = {
      fs: makeWorkspace().fs,
      sessionId: "session-a",
      assets: { share: async () => "https://example.test" },
    };

    expect(createAITools({ workspace, assets: false }).publish).toBeUndefined();
    expect(createAITools({ workspace, readonly: true }).publish).toBeUndefined();
  });

  it("returns structured publish errors", async () => {
    const workspace = {
      fs: makeWorkspace().fs,
      sessionId: "session-a",
      assets: {
        async share() {
          throw new Error("upload failed");
        },
      },
    };
    const tools = createAITools({ workspace });

    await expect(
      executeTool(tools.publish, { path: "/workspace/out/report.html" }),
    ).resolves.toEqual({
      ok: false,
      error: "upload failed",
    });
  });
});
