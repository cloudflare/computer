import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import type { WorkspaceRuntimeExecHandle, WorkspaceRuntimeResult } from "../runtime/types.js";
import { Workspace } from "../workspace.js";
import {
  createAITools,
  createDeleteTool,
  createEditTool,
  createFindTool,
  createGrepTool,
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

async function modelOutput(tool: unknown, input: unknown, output: unknown): Promise<unknown> {
  const toModelOutput = (
    tool as {
      toModelOutput?: (options: { input: unknown; output: unknown }) => unknown;
    }
  ).toModelOutput;
  if (!toModelOutput) throw new Error("tool has no toModelOutput function");
  return toModelOutput({ input, output });
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
  it("opens one ranged stream for a bounded read", async () => {
    const calls: Array<{ byteOffset?: number; byteLength?: number }> = [];
    const content = bytes("abcdefghij");
    const workspace = {
      fs: {
        async stat() {
          throw new Error("stat must not be called by readChunks");
        },
        async readFile(
          _path: string,
          options: { byteOffset?: number; byteLength?: number } = {},
        ): Promise<ReadableStream<Uint8Array>> {
          calls.push(options);
          const start = options.byteOffset ?? 0;
          const end = options.byteLength === undefined ? undefined : start + options.byteLength;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(content.slice(start, end));
              controller.close();
            },
          });
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
      },
    };
    const store = new WorkspaceFileStore(workspace);

    await expect(
      drainChunks(store.readChunks("/workspace/range.txt", 2, 5)).then(decode),
    ).resolves.toBe("cdefg");
    expect(calls).toEqual([{ byteOffset: 2, byteLength: 5 }]);
  });

  it("still validates the path for a zero-length read", async () => {
    const store = new WorkspaceFileStore(makeWorkspace());

    await expect(drainChunks(store.readChunks("/missing", 0, 0))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects directories instead of treating them as empty files", async () => {
    const workspace = makeWorkspace();
    await workspace.fs.mkdir("/directory");
    const store = new WorkspaceFileStore(workspace);

    await expect(drainChunks(store.readChunks("/directory"))).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("keeps a real multi-chunk workspace read on one snapshot", async () => {
    const workspace = makeWorkspace();
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const original = new Uint8Array(600_000);
    original.fill(0x41, 0, 500_000);
    original.fill(0x42, 500_000);
    await workspace.fs.writeFile("/workspace/large.bin", original);
    const store = new WorkspaceFileStore(workspace);

    const chunks = store.readChunks("/workspace/large.bin")[Symbol.asyncIterator]();
    const first = await chunks.next();
    expect(first.done).toBe(false);
    await workspace.fs.writeFile(
      "/workspace/large.bin",
      new Uint8Array(original.length).fill(0x43),
    );

    const parts = [first.value];
    while (true) {
      const next = await chunks.next();
      if (next.done) break;
      parts.push(next.value);
    }
    const result = await drainChunks(
      (async function* () {
        yield* parts;
      })(),
    );
    expect(result.byteLength).toBe(original.byteLength);
    expect(result.every((value, index) => value === original[index])).toBe(true);
  });

  it("cancels a ranged stream when its consumer stops early", async () => {
    let cancelled = false;
    const workspace = {
      fs: {
        async stat() {
          throw new Error("stat must not be called by readChunks");
        },
        async readFile(): Promise<ReadableStream<Uint8Array>> {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(bytes("first"));
              controller.enqueue(bytes("second"));
            },
            cancel() {
              cancelled = true;
            },
          });
        },
        async writeFile() {},
        async mkdir() {},
        async rm() {},
      },
    };
    const store = new WorkspaceFileStore(workspace);

    for await (const _chunk of store.readChunks("/workspace/range.txt")) break;
    expect(cancelled).toBe(true);
  });
});

describe("createAITools filesystem tools", () => {
  it("creates the complete filesystem tool set by default", () => {
    const tools = createAITools({ workspace: makeWorkspace() });

    expect(Object.keys(tools).sort()).toEqual([
      "delete",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("states the default ls page size in the tool description", () => {
    const tools = createAITools({ workspace: makeWorkspace() });

    expect(toolDescription(tools.ls)).toContain("defaults to 200 entries");
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

    expect(Object.keys(tools).sort()).toEqual(["find", "grep", "ls", "read"]);
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
      count: 1,
      entries: [
        {
          name: "todo.txt",
          size: 8,
          mtime: 1_700_000_000_000,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        },
      ],
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

  it("paginates ls results and reports a continuation offset", async () => {
    const workspace = makeWorkspace();
    await workspace.fs.mkdir("/workspace", { recursive: true });
    for (const name of ["a", "b", "c"]) {
      await workspace.fs.writeFile(`/workspace/${name}`, name);
    }
    const tools = createAITools({ workspace });

    await expect(
      executeTool(tools.ls, { path: "/workspace", limit: 2, offset: 0 }),
    ).resolves.toMatchObject({
      count: 2,
      entries: [
        { name: "a", size: 1 },
        { name: "b", size: 1 },
      ],
      nextOffset: 2,
    });
    await expect(
      executeTool(tools.ls, { path: "/workspace", limit: 2, offset: 2 }),
    ).resolves.toMatchObject({
      count: 1,
      entries: [{ name: "c", size: 1 }],
    });
  });

  it("serializes write behind an edit on the same store and path", async () => {
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const writes: string[] = [];
    const store: FileStore = {
      async stat() {
        return { size: 3, mtime: 1 };
      },
      async readAll() {
        markReadStarted?.();
        await readGate;
        return bytes("old");
      },
      async *readChunks() {
        yield bytes("old");
      },
      async write(_path, content) {
        writes.push(decode(content));
      },
    };
    const edit = executeTool(createEditTool({ store }), {
      path: "/workspace/file.txt",
      edits: [{ oldText: "old", newText: "edited" }],
    });
    await readStarted;

    const write = executeTool(createWriteTool({ store }), {
      path: "/workspace/file.txt",
      content: "written",
    });
    await Promise.resolve();
    const writesBeforeEditFinished = [...writes];

    releaseRead?.();
    await Promise.all([edit, write]);
    expect(writesBeforeEditFinished).toEqual([]);
    expect(writes).toEqual(["edited", "written"]);
  });

  it("shares mutation locks across tool sets for the same workspace", async () => {
    const workspace = makeWorkspace();
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/file.txt", "old");
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const originalReadFile = workspace.fs.readFile.bind(workspace.fs);
    const originalWriteFile = workspace.fs.writeFile.bind(workspace.fs);
    const writes: string[] = [];
    workspace.fs.readFile = async (...args: Parameters<typeof workspace.fs.readFile>) => {
      markReadStarted?.();
      await readGate;
      return originalReadFile(...args);
    };
    workspace.fs.writeFile = async (...args: Parameters<typeof workspace.fs.writeFile>) => {
      const content = args[1];
      if (content instanceof Uint8Array) writes.push(decode(content));
      return originalWriteFile(...args);
    };

    const firstTools = createAITools({ workspace });
    const secondTools = createAITools({ workspace });
    const edit = executeTool(firstTools.edit, {
      path: "/workspace/file.txt",
      edits: [{ oldText: "old", newText: "edited" }],
    });
    await readStarted;
    const write = executeTool(secondTools.write, {
      path: "/workspace/file.txt",
      content: "written",
    });
    await Promise.resolve();
    const writesBeforeEditFinished = [...writes];

    releaseRead?.();
    await Promise.all([edit, write]);
    expect(writesBeforeEditFinished).toEqual([]);
    expect(writes).toEqual(["edited", "written"]);
  });

  it("does not share edit locks between stores", async () => {
    let releaseRead: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const first = memoryStore({ content: "old" });
    first.readAll = async () => {
      markFirstStarted?.();
      await readGate;
      return bytes("old");
    };
    const second = memoryStore({ content: "old" });
    second.readAll = async () => {
      markSecondStarted?.();
      return bytes("old");
    };

    const firstEdit = executeTool(createEditTool({ store: first }), {
      path: "/workspace/file.txt",
      edits: [{ oldText: "old", newText: "first" }],
    });
    await firstStarted;
    const secondEdit = executeTool(createEditTool({ store: second }), {
      path: "/workspace/file.txt",
      edits: [{ oldText: "old", newText: "second" }],
    });

    const secondAcquired = await Promise.race([
      secondStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);

    releaseRead?.();
    await Promise.all([firstEdit, secondEdit]);
    expect(secondAcquired).toBe(true);
  });

  it("passes find pagination to the workspace filesystem", async () => {
    let received: { limit?: number; offset?: number } | undefined;
    const tool = createFindTool({
      workspace: {
        fs: {
          async find(_path, _pattern, options) {
            received = options;
            return [{ path: "/workspace/a.ts", type: "file" }];
          },
        },
      },
    });

    await executeTool(tool, {
      path: "/workspace",
      pattern: "**/*.ts",
      limit: 2,
      offset: 7,
    });
    expect(received).toEqual({ limit: 3, offset: 7 });
  });

  it("passes grep include and pagination to one filesystem search", async () => {
    let received: Record<string, unknown> | undefined;
    const tool = createGrepTool({
      workspace: {
        fs: {
          async find() {
            throw new Error("find must not be called by the grep tool");
          },
          async grep(_query, _path, options) {
            received = options;
            return [];
          },
        },
      },
    });

    await executeTool(tool, {
      path: "/workspace",
      query: "TODO.+",
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2,
      limit: 2,
      offset: 7,
    });
    expect(received).toEqual({
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2,
      limit: 3,
      offset: 7,
    });
  });

  it("defaults grep to literal case-sensitive matching", async () => {
    const workspace = makeWorkspace();
    const tool = createGrepTool({ workspace });
    await workspace.fs.mkdir("/workspace");
    await workspace.fs.writeFile("/workspace/search.txt", "TODO\ntodo\nT.DO\n");

    await expect(
      executeTool(tool, { path: "/workspace/search.txt", query: "T.DO" }),
    ).resolves.toMatchObject({
      count: 1,
      matches: [{ path: "/workspace/search.txt", line: 3, text: "T.DO" }],
    });
  });

  it("accepts grep continuation offsets produced after large result sets", () => {
    const tool = createGrepTool({
      workspace: {
        fs: {
          async find() {
            return [];
          },
          async grep() {
            return [];
          },
        },
      },
    });
    const schema = tool.inputSchema as {
      safeParse(input: unknown): { success: boolean };
    };

    expect(schema.safeParse({ path: "/workspace", query: "needle", offset: 10_200 }).success).toBe(
      true,
    );
  });

  it("finds, greps, and deletes files through a real Workspace", async () => {
    const workspace = makeWorkspace();
    const tools = createAITools({ workspace });
    await workspace.fs.mkdir("/workspace/src", { recursive: true });
    await workspace.fs.writeFile("/workspace/src/a.ts", "const value = 'TODO';\n");
    await workspace.fs.writeFile("/workspace/src/b.md", "todo in docs\n");

    await expect(
      executeTool(tools.find, { path: "/workspace", pattern: "**/*.ts", limit: 20 }),
    ).resolves.toEqual({
      path: "/workspace",
      pattern: "**/*.ts",
      count: 1,
      entries: [{ path: "/workspace/src/a.ts", type: "file" }],
    });
    await expect(
      executeTool(tools.grep, {
        path: "/workspace",
        query: "todo",
        include: "**/*.ts",
        ignoreCase: true,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      count: 1,
      matches: [{ path: "/workspace/src/a.ts", line: 1, text: "const value = 'TODO';" }],
    });
    await expect(executeTool(tools.delete, { path: "/workspace/src/a.ts" })).resolves.toEqual({
      deleted: "/workspace/src/a.ts",
    });
    await expect(workspace.fs.stat("/workspace/src/a.ts")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes delete behind an edit on the same store and path", async () => {
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const events: string[] = [];
    const store = memoryStore({
      content: "old",
      onWrite() {
        events.push("edit");
      },
    });
    store.readAll = async () => {
      markReadStarted?.();
      await readGate;
      return bytes("old");
    };
    const deleteStore = Object.assign(store, {
      async remove() {
        events.push("delete");
      },
    });
    const edit = executeTool(createEditTool({ store }), {
      path: "/workspace/file.txt",
      edits: [{ oldText: "old", newText: "edited" }],
    });
    await readStarted;
    const deletion = executeTool(createDeleteTool({ store: deleteStore }), {
      path: "/workspace/file.txt",
    });
    await Promise.resolve();
    const eventsBeforeEditFinished = [...events];

    releaseRead?.();
    await Promise.all([edit, deletion]);
    expect(eventsBeforeEditFinished).toEqual([]);
    expect(events).toEqual(["edit", "delete"]);
  });

  it("serializes recursive delete behind a mutation in its subtree", async () => {
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const events: string[] = [];
    const store = memoryStore({
      content: "old",
      onWrite() {
        events.push("edit");
      },
    });
    store.readAll = async () => {
      markReadStarted?.();
      await readGate;
      return bytes("old");
    };
    const deleteStore = Object.assign(store, {
      async remove() {
        events.push("delete");
      },
    });
    const edit = executeTool(createEditTool({ store }), {
      path: "/workspace/tree/file.txt",
      edits: [{ oldText: "old", newText: "edited" }],
    });
    await readStarted;
    const deletion = executeTool(createDeleteTool({ store: deleteStore }), {
      path: "/workspace/tree",
      recursive: true,
    });
    await Promise.resolve();
    const eventsBeforeEditFinished = [...events];

    releaseRead?.();
    await Promise.all([edit, deletion]);
    expect(eventsBeforeEditFinished).toEqual([]);
    expect(events).toEqual(["edit", "delete"]);
  });

  it("allows unrelated mutations while a recursive delete is pending", async () => {
    let releaseRemove: (() => void) | undefined;
    let markRemoveStarted: (() => void) | undefined;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    const events: string[] = [];
    const store = Object.assign(memoryStore({ content: "old" }), {
      async remove() {
        markRemoveStarted?.();
        await removeGate;
        events.push("delete");
      },
    });
    const deletion = executeTool(createDeleteTool({ store }), {
      path: "/workspace/tree",
      recursive: true,
    });
    await removeStarted;
    const write = executeTool(createWriteTool({ store }), {
      path: "/workspace/other.txt",
      content: "new",
    }).then(() => events.push("write"));
    await write;

    expect(events).toEqual(["write"]);
    releaseRemove?.();
    await deletion;
    expect(events).toEqual(["write", "delete"]);
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
      error: "Line 1 exceeds the 3-byte read cap. Increase the cap or configure lineTruncation.",
    });
  });

  it("optionally includes line numbers", async () => {
    const store = memoryStore({ content: "one\ntwo\n" });
    const plain = createReadTool({ store });
    const numbered = createReadTool({ store, includeLineNumbers: true });

    await expect(executeTool(plain, { path: "/workspace/file.txt" })).resolves.toMatchObject({
      content: "one\ntwo",
    });
    await expect(executeTool(numbered, { path: "/workspace/file.txt" })).resolves.toMatchObject({
      content: "1\tone\n2\ttwo",
    });
  });

  it("truncates long lines by characters or UTF-8 bytes", async () => {
    const store = memoryStore({ content: "a😀bc\n" });
    const byChars = createReadTool({ store, lineTruncation: { chars: 2 } });
    const byBytes = createReadTool({ store, lineTruncation: { bytes: 5 } });

    await expect(executeTool(byChars, { path: "/workspace/file.txt" })).resolves.toMatchObject({
      content: "a😀... (truncated)",
    });
    await expect(executeTool(byBytes, { path: "/workspace/file.txt" })).resolves.toMatchObject({
      content: "a😀... (truncated)",
    });
  });

  it("continues from the first unread byte on the next page", async () => {
    const content = bytes("first\nsecond\nthird\n");
    const offsets: number[] = [];
    const store: FileStore = {
      async stat() {
        return { size: content.length, mtime: 1 };
      },
      async *readChunks(_path, byteOffset = 0, byteLength) {
        offsets.push(byteOffset);
        yield content.slice(
          byteOffset,
          byteLength === undefined ? undefined : byteOffset + byteLength,
        );
      },
      async readAll() {
        return content;
      },
      async write() {},
    };
    const tool = createReadTool({ store });
    const first = (await executeTool(tool, {
      path: "/workspace/file.txt",
      limit: 1,
    })) as { nextOffset: number; nextByteOffset: number };
    await executeTool(tool, {
      path: "/workspace/file.txt",
      offset: first.nextOffset,
      byteOffset: first.nextByteOffset,
      limit: 1,
    });

    expect(first).toMatchObject({ nextOffset: 2, nextByteOffset: 6 });
    expect(offsets).toEqual([0, 6]);
  });

  it("treats a zero byte offset as the start of the file", async () => {
    const tool = createReadTool({ store: memoryStore({ content: "first\nsecond\nthird\n" }) });

    await expect(
      executeTool(tool, {
        path: "/workspace/file.txt",
        offset: 2,
        byteOffset: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      content: "second",
      startLine: 2,
      endLine: 2,
      nextOffset: 3,
      nextByteOffset: 13,
    });
  });

  it("keeps text continuations in truncated model output", async () => {
    const tool = createReadTool({ store: memoryStore({ content: "first\nsecond\n" }) });
    const truncated = await executeTool(tool, { path: "/workspace/file.txt", limit: 1 });
    const complete = await executeTool(tool, { path: "/workspace/file.txt" });

    await expect(
      modelOutput(tool, { path: "/workspace/file.txt", limit: 1 }, truncated),
    ).resolves.toEqual({ type: "json", value: truncated });
    await expect(modelOutput(tool, { path: "/workspace/file.txt" }, complete)).resolves.toEqual({
      type: "text",
      value: "first\nsecond",
    });
  });

  it("stops pulling chunks as soon as the line cap is complete", async () => {
    const chunks = [bytes("first\nsecond"), bytes(" line continues"), bytes(" to the end")];
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    let chunksRead = 0;
    const store: FileStore = {
      async stat() {
        return { size, mtime: 1 };
      },
      async *readChunks() {
        for (const chunk of chunks) {
          chunksRead += 1;
          yield chunk;
        }
      },
      async readAll() {
        return null;
      },
      async write() {},
    };
    const tool = createReadTool({ store });

    await expect(
      executeTool(tool, { path: "/workspace/file.txt", limit: 1 }),
    ).resolves.toMatchObject({
      content: "first",
      truncated: true,
      nextOffset: 2,
      nextByteOffset: 6,
    });
    expect(chunksRead).toBe(1);
  });

  it("returns image extensions as file-data model output", async () => {
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const store = memoryStore({ size: content.length });
    store.readAll = async () => content;
    store.readChunks = async function* (_path, offset = 0, length) {
      yield content.slice(offset, length === undefined ? undefined : offset + length);
    };
    const tool = createReadTool({ store });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    expect(output).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      sizeBytes: content.length,
    });
    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "Read /workspace/image.png (image/png, 4 bytes)." },
        {
          type: "file-data",
          data: "iVBORw==",
          mediaType: "image/png",
          filename: "image.png",
        },
      ],
    });
  });

  it("sniffs only a bounded prefix for files without a known extension", async () => {
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...bytes("body")]);
    const ranges: Array<{ offset: number; length: number | undefined }> = [];
    const store = memoryStore({ size: content.length });
    store.readChunks = async function* (_path, offset = 0, length) {
      ranges.push({ offset, length });
      yield content.slice(offset, length === undefined ? undefined : offset + length);
    };
    const tool = createReadTool({ store });

    await expect(executeTool(tool, { path: "/workspace/upload" })).resolves.toMatchObject({
      kind: "file",
      mediaType: "application/pdf",
    });
    expect(ranges).toEqual([{ offset: 0, length: 512 }]);
  });

  it("sniffs SVG only when it is the root element", async () => {
    for (const content of [
      '<svg viewBox="0 0 1 1"></svg>',
      '<?xml version="1.0"?>\n<svg></svg>',
      '<?xml-stylesheet type="text/css" href="style.css"?>\n<svg></svg>',
      '<!DOCTYPE svg SYSTEM "about:legacy-compat">\n<svg></svg>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg></svg>',
      '<!DOCTYPE svg [<!ENTITY greater ">">]>\n<svg></svg>',
      "<!-- generated -->\n<svg></svg>",
    ]) {
      const tool = createReadTool({ store: memoryStore({ content }) });
      await expect(executeTool(tool, { path: "/workspace/upload" })).resolves.toMatchObject({
        kind: "image",
        mediaType: "image/svg+xml",
      });
    }

    for (const content of [
      "const markup = '<svg></svg>';",
      "<html><body><svg></svg></body></html>",
      "<svgscript>not an svg root</svgscript>",
    ]) {
      const tool = createReadTool({ store: memoryStore({ content }) });
      const output = await executeTool(tool, { path: "/workspace/upload" });
      expect(output).toMatchObject({ content, truncated: false });
    }
  });

  it("rejects oversized inline media before reading the whole file", async () => {
    let readAll = false;
    const store = memoryStore({ size: 10 });
    store.readAll = async () => {
      readAll = true;
      return new Uint8Array(10);
    };
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).resolves.toEqual({
      type: "error-text",
      value:
        "Read /workspace/image.png (image/png, 10 bytes), but it exceeds the 4-byte inline model output limit.",
    });
    expect(readAll).toBe(false);
  });

  it("bounds the inline read when media grows after the size check", async () => {
    const content = new Uint8Array(10);
    const ranges: Array<{ offset: number; length: number | undefined }> = [];
    const store = memoryStore({ size: 2 });
    store.readAll = async () => {
      throw new Error("inline media must not use readAll");
    };
    store.readChunks = async function* (_path, offset = 0, length) {
      ranges.push({ offset, length });
      yield content.slice(offset, length === undefined ? undefined : offset + length);
    };
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).resolves.toEqual({
      type: "error-text",
      value:
        "Read /workspace/image.png (image/png, 5 bytes), but it exceeds the 4-byte inline model output limit.",
    });
    expect(ranges).toEqual([{ offset: 0, length: 5 }]);
  });

  it("reports inline media deleted after the size check", async () => {
    const store = memoryStore({ size: 2 });
    store.readChunks = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Uint8Array>> {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).resolves.toEqual({
      type: "error-text",
      value: "Could not read file bytes: /workspace/image.png",
    });
  });

  it("recognizes message-only missing media errors", async () => {
    const store = memoryStore({ size: 2 });
    store.readChunks = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Uint8Array>> {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).resolves.toEqual({
      type: "error-text",
      value: "Could not read file bytes: /workspace/image.png",
    });
  });

  it("does not confuse unrelated no-such errors with missing media", async () => {
    const failure = new Error("SQLITE_ERROR: no such table: vfs_chunks");
    const store = memoryStore({ size: 2 });
    store.readChunks = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Uint8Array>> {
        throw failure;
      },
    });
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).rejects.toBe(failure);
  });

  it("does not hide unrelated inline media read failures", async () => {
    const failure = new Error("storage unavailable");
    const store = memoryStore({ size: 2 });
    store.readChunks = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Uint8Array>> {
        throw failure;
      },
    });
    const tool = createReadTool({ store, maxModelBytes: 4 });
    const output = await executeTool(tool, { path: "/workspace/image.png" });

    await expect(modelOutput(tool, { path: "/workspace/image.png" }, output)).rejects.toBe(failure);
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
