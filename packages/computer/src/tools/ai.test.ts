import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import type { WorkspaceRuntimeExecHandle, WorkspaceRuntimeResult } from "../runtime/types.js";
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
  const output = await execute(input, toolOptions);
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    let last: unknown;
    for await (const chunk of output as AsyncIterable<unknown>) last = chunk;
    return last;
  }
  return output;
}

async function collectTool(tool: unknown, input: unknown): Promise<unknown[]> {
  const execute = (tool as { execute?: (input: unknown, options: typeof toolOptions) => unknown })
    .execute;
  if (!execute) throw new Error("tool has no execute function");
  const output = await execute(input, toolOptions);
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) {
    return [output];
  }
  const chunks: unknown[] = [];
  for await (const chunk of output as AsyncIterable<unknown>) chunks.push(chunk);
  return chunks;
}

type ExecStreamEvent =
  | { name: "stdout"; value: string }
  | { name: "stderr"; value: string }
  | { name: "exit"; code: number; result?: unknown };

function streamingHandle(events: ExecStreamEvent[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => {
      throw new Error("result() must not be called on a streamed handle");
    },
  };
}

// A clock that advances 200ms per read, past the 100ms coalescing
// floor, so every chunk produces its own running snapshot. Streaming
// tests that assert per-chunk output inject this to defeat coalescing.
function steppingClock(stepMs = 200): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function toolDescription(tool: unknown): string {
  const description = (tool as { description?: unknown }).description;
  if (typeof description !== "string") throw new Error("tool has no description");
  return description;
}

function makeWorkspace(): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), now: () => 1_700_000_000_000 });
}

// An in-process command backend that streams a fixed event sequence.
// Registered on a real Workspace so the exec tool runs against the
// genuine WorkspaceRuntime handle rather than a hand-shaped fake:
// this pins the ExecWorkspaceLike binding and the assumption that the
// real handle is async-iterable.
function streamingCommandBackend(events: import("@cloudflare/computer-rpc").ExecEvent[]): {
  id: string;
  type: string;
  connect(): Promise<{
    rpc: import("@cloudflare/computer-rpc").WorkspaceRPC;
    sync: "none";
    close(): Promise<void>;
  }>;
} {
  const shell: import("@cloudflare/computer-rpc").ShellRPC = {
    async exec(input) {
      const id = input.id ?? "cmd-1";
      return {
        id,
        events: new ReadableStream({
          start(controller) {
            for (const event of events) controller.enqueue({ ...event, id });
            controller.close();
          },
        }),
      };
    },
    getExec: () => Promise.reject(new Error("not used")),
    killExec: () => Promise.resolve(),
    disposeExec: () => Promise.resolve(),
  };
  const noopSync = new Proxy(
    {},
    { get: () => () => Promise.reject(new Error("sync: none")) },
  ) as import("@cloudflare/computer-rpc").SyncRPC;
  return {
    id: "shell",
    type: "fake-command",
    async connect() {
      return { rpc: { sync: noopSync, shell }, sync: "none", close: async () => {} };
    },
  };
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
  it("uses readRange without streaming skipped bytes from Workspace.fs", async () => {
    const calls: Array<{ offset: number; length: number }> = [];
    const content = bytes("abcdefghij");
    const workspace = {
      fs: {
        async stat() {
          return {
            size: content.length,
            mtime: 1,
            mode: 0o100644,
            isFile: true,
            isDirectory: false,
          };
        },
        async readRange(_path: string, offset: number, length: number) {
          calls.push({ offset, length });
          return content.slice(offset, offset + length);
        },
        async readFile(): Promise<ReadableStream<Uint8Array>> {
          throw new Error("readFile must not be called for ranged reads");
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
    expect(calls).toEqual([{ offset: 2, length: 5 }]);
  });

  it("splits unbounded reads into fixed-size ranges", async () => {
    const calls: Array<{ offset: number; length: number }> = [];
    const content = new Uint8Array(150_000).fill(7);
    const workspace = {
      fs: {
        async stat() {
          return {
            size: content.length,
            mtime: 1,
            mode: 0o100644,
            isFile: true,
            isDirectory: false,
          };
        },
        async readRange(_path: string, offset: number, length: number) {
          calls.push({ offset, length });
          return content.slice(offset, offset + length);
        },
        async readFile(): Promise<ReadableStream<Uint8Array>> {
          throw new Error("readFile must not be called for ranged reads");
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

    await expect(drainChunks(store.readChunks("/workspace/large.bin"))).resolves.toHaveLength(
      content.length,
    );
    expect(calls).toEqual([
      { offset: 0, length: 65_536 },
      { offset: 65_536, length: 65_536 },
      { offset: 131_072, length: 18_928 },
    ]);
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
      runtime: {
        async exec(command: string, options: { cwd?: string; encoding: "utf8"; backend?: string }) {
          calls.push({ command, cwd: options.cwd, backend: options.backend });
          const result: WorkspaceRuntimeResult<"utf8"> = {
            exitCode: 2,
            stdout: "abcdef",
            stderr: "uvwxyz",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as unknown as WorkspaceRuntimeExecHandle<"utf8">;
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
      runtime: {
        async exec() {
          const result: WorkspaceRuntimeResult<"utf8"> = {
            exitCode: 0,
            stdout: "a🙂b",
            stderr: "🙂🙂",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as unknown as WorkspaceRuntimeExecHandle<"utf8">;
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
      runtime: {
        async exec(command: string, options: { encoding: "utf8"; backend?: string }) {
          calls.push({ command, backend: options.backend });
          const result: WorkspaceRuntimeResult<"utf8"> = {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            pushed: 0,
            pulled: 0,
            skipped: [],
          };
          return { result: async () => result } as unknown as WorkspaceRuntimeExecHandle<"utf8">;
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
      runtime: {
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
      runtime: {
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
      runtime: {
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

describe("createAITools callable exec", () => {
  it("forwards env and input to the runtime and returns the result value", async () => {
    const calls: Array<{
      command: string;
      env: Record<string, string> | undefined;
      input: unknown;
      backend: string | undefined;
    }> = [];
    const workspace = {
      runtime: {
        async exec(
          command: string,
          options: {
            cwd?: string;
            encoding: "utf8";
            backend?: string;
            env?: Record<string, string>;
            input?: unknown;
          },
        ) {
          calls.push({
            command,
            env: options.env,
            input: options.input,
            backend: options.backend,
          });
          return {
            result: async () => ({
              exitCode: 0,
              stdout: "ran",
              stderr: "",
              value: { doubled: 84 },
            }),
          };
        },
        isCallable: (id: string) => id === "js",
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "js",
        backends: {
          js: { description: "JavaScript module runtime" },
        },
      },
    });

    await expect(
      executeTool(tools.exec, {
        command: "export default (input) => ({ doubled: input.value * 2 })",
        env: { API_KEY: "secret" },
        input: { value: 42 },
      }),
    ).resolves.toEqual({
      command: "export default (input) => ({ doubled: input.value * 2 })",
      cwd: null,
      backend: "js",
      exitCode: 0,
      stdout: "ran",
      stderr: "",
      result: { doubled: 84 },
    });
    expect(calls).toEqual([
      {
        command: "export default (input) => ({ doubled: input.value * 2 })",
        env: { API_KEY: "secret" },
        input: { value: 42 },
        backend: "js",
      },
    ]);
  });

  it("omits the result field when the backend returns no value", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return {
            result: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          };
        },
        isCallable: (id: string) => id === "js",
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "js",
        backends: { js: { description: "JavaScript module runtime" } },
      },
    });

    const output = (await executeTool(tools.exec, { command: "noop" })) as Record<string, unknown>;
    expect(output).not.toHaveProperty("result");
    expect(output).toMatchObject({ backend: "js", exitCode: 0, stdout: "ok" });
  });

  it("errors quickly without calling the backend when input targets a non-callable backend", async () => {
    let called = false;
    const workspace = {
      runtime: {
        async exec() {
          called = true;
          return { result: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
        },
        isCallable: (id: string) => id === "js",
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: { description: "fast shell" },
          js: { description: "JavaScript module runtime" },
        },
      },
    });

    await expect(
      executeTool(tools.exec, { command: "echo hi", input: { value: 1 }, backend: "shell" }),
    ).resolves.toEqual({
      command: "echo hi",
      cwd: null,
      backend: "shell",
      error: 'Backend "shell" is not callable; it does not accept structured input.',
    });
    expect(called).toBe(false);
  });

  it("allows env on non-callable backends", async () => {
    const calls: Array<{ env: Record<string, string> | undefined; input: unknown }> = [];
    const workspace = {
      runtime: {
        async exec(_command: string, options: { env?: Record<string, string>; input?: unknown }) {
          calls.push({ env: options.env, input: options.input });
          return { result: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
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

    await expect(
      executeTool(tools.exec, { command: "env", env: { FOO: "bar" } }),
    ).resolves.toMatchObject({ backend: "shell", exitCode: 0 });
    expect(calls).toEqual([{ env: { FOO: "bar" }, input: undefined }]);
  });

  it("describes callable backends in the tool description", () => {
    const workspace = {
      runtime: {
        async exec() {
          throw new Error("not used");
        },
        isCallable: (id: string) => id === "js",
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "js",
        backends: { js: { description: "JavaScript module runtime" } },
      },
    });

    expect(toolDescription(tools.exec)).toContain("callable");
  });
});

describe("createAITools exec against a real Workspace", () => {
  it("streams a real runtime handle end to end", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        streamingCommandBackend([
          { id: "cmd-1", seq: 1, name: "stdout", value: new TextEncoder().encode("hello\n") },
          { id: "cmd-1", seq: 2, name: "exit", code: 0 },
        ]) as never,
      ],
    });
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
      },
    });

    const chunks = await collectTool(tools.exec, { command: "echo hello" });
    expect(chunks.at(-1)).toEqual({
      command: "echo hello",
      cwd: null,
      backend: "shell",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    await workspace.close();
  });
});

describe("createAITools exec streaming", () => {
  it("streams stdout and stderr chunks and yields a final aggregate", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return streamingHandle([
            { name: "stdout", value: "one\n" },
            { name: "stderr", value: "warn\n" },
            { name: "stdout", value: "two\n" },
            { name: "exit", code: 0 },
          ]);
        },
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
        now: steppingClock(),
      },
    });

    await expect(collectTool(tools.exec, { command: "run" })).resolves.toEqual([
      { command: "run", cwd: null, backend: "shell", exitCode: null, stdout: "one\n", stderr: "" },
      {
        command: "run",
        cwd: null,
        backend: "shell",
        exitCode: null,
        stdout: "one\n",
        stderr: "warn\n",
      },
      {
        command: "run",
        cwd: null,
        backend: "shell",
        exitCode: null,
        stdout: "one\ntwo\n",
        stderr: "warn\n",
      },
      {
        command: "run",
        cwd: null,
        backend: "shell",
        exitCode: 0,
        stdout: "one\ntwo\n",
        stderr: "warn\n",
      },
    ]);
  });

  it("streams a callable backend's result folded onto the exit event", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return streamingHandle([
            { name: "stdout", value: "working\n" },
            { name: "exit", code: 0, result: { ok: true } },
          ]);
        },
        isCallable: (id: string) => id === "js",
      },
    };
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "js",
        backends: { js: { description: "JavaScript module runtime" } },
      },
    });

    const chunks = await collectTool(tools.exec, {
      command: "export default () => ({ ok: true })",
      input: {},
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.at(-1)).toEqual({
      command: "export default () => ({ ok: true })",
      cwd: null,
      backend: "js",
      exitCode: 0,
      stdout: "working\n",
      stderr: "",
      result: { ok: true },
    });
  });

  it("truncates streamed output on UTF-8 byte boundaries", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return streamingHandle([
            { name: "stdout", value: "a\u{1f642}b" },
            { name: "exit", code: 0 },
          ]);
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

    const chunks = await collectTool(tools.exec, { command: "echo emoji" });
    expect(chunks.at(-1)).toMatchObject({
      exitCode: 0,
      stdout: "a\u{1f642}\n\n[truncated, 1 more bytes]",
    });
  });

  it("yields a structured error when the stream fails mid-run", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { name: "stdout", value: "partial\n" } as ExecStreamEvent;
              throw new Error("stream broke");
            },
            result: async () => {
              throw new Error("result() must not be called on a streamed handle");
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

    const chunks = await collectTool(tools.exec, { command: "run" });
    expect(chunks.at(-1)).toEqual({
      command: "run",
      cwd: null,
      backend: "shell",
      error: "stream broke",
    });
  });

  it("coalesces running snapshots to at most one per interval", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return streamingHandle([
            { name: "stdout", value: "a" },
            { name: "stdout", value: "b" },
            { name: "stdout", value: "c" },
            { name: "exit", code: 0 },
          ]);
        },
      },
    };
    // A frozen clock never advances past the coalescing floor. The
    // first chunk still yields a running snapshot for responsiveness;
    // the later chunks coalesce into the terminal snapshot.
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
        now: () => 1000,
      },
    });

    const chunks = await collectTool(tools.exec, { command: "run" });
    expect(chunks).toEqual([
      { command: "run", cwd: null, backend: "shell", exitCode: null, stdout: "a", stderr: "" },
      { command: "run", cwd: null, backend: "shell", exitCode: 0, stdout: "abc", stderr: "" },
    ]);
  });

  it("caps streamed output in memory at streamMaxBytes", async () => {
    const workspace = {
      runtime: {
        async exec() {
          return streamingHandle([
            { name: "stdout", value: "a".repeat(10) },
            { name: "stdout", value: "b".repeat(10) },
            { name: "exit", code: 0 },
          ]);
        },
      },
    };
    // Hold at most 12 bytes; show at most 8. The marker counts every
    // byte seen (20), not just the 12 retained.
    const tools = createAITools({
      workspace,
      shell: {
        defaultBackend: "shell",
        backends: { shell: { description: "fast shell" } },
        maxBytes: 8,
        streamMaxBytes: 12,
      },
    });

    const chunks = await collectTool(tools.exec, { command: "run" });
    expect(chunks.at(-1)).toMatchObject({
      exitCode: 0,
      stdout: "aaaaaaaa\n\n[truncated, 12 more bytes]",
    });
  });

  it("kills the backend execution when the turn aborts", async () => {
    let killed = 0;
    const controller = new AbortController();
    const workspace = {
      runtime: {
        async exec() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { name: "stdout", value: "working\n" } as ExecStreamEvent;
              controller.abort();
              // The abort listener calls kill(); yield once more so
              // the iteration observes the signal before the stream
              // ends on its own.
              yield { name: "exit", code: 130 } as ExecStreamEvent;
            },
            result: async () => {
              throw new Error("result() must not be called on a streamed handle");
            },
            kill: async () => {
              killed += 1;
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

    const execute = (
      tools.exec as {
        execute: (
          input: unknown,
          options: { toolCallId: string; messages: []; abortSignal: AbortSignal },
        ) => AsyncIterable<unknown>;
      }
    ).execute;
    const output = execute(
      { command: "sleep" },
      { toolCallId: "t", messages: [], abortSignal: controller.signal },
    );
    for await (const _chunk of output) {
      // Drain to completion.
    }
    expect(killed).toBe(1);
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
