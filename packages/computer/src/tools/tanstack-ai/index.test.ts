import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { isContentPartArray } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkerJavaScriptBackend } from "../../backends/worker-javascript/worker-javascript.js";
import { Workspace } from "../../workspace.js";
import { createTanStackTools } from "./index.js";

function makeWorkspace(): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), now: () => 1_700_000_000_000 });
}

// Streams a fixed event sequence through a real WorkspaceRuntime
// handle, rather than a hand-shaped fake.
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

// A command that prints once and then stays quiet until killed or
// released, the shape that exposes buffering and cancellation bugs.
function quietCommandBackend(): {
  backend: ReturnType<typeof streamingCommandBackend>;
  killed: Promise<void>;
  release(): void;
} {
  let finish: (() => void) | undefined;
  let markKilled: () => void = () => {};
  const killed = new Promise<void>((resolve) => {
    markKilled = resolve;
  });
  const base = streamingCommandBackend([]);
  const backend = {
    ...base,
    async connect() {
      const connection = await base.connect();
      connection.rpc.shell.exec = async (input) => {
        const id = input.id ?? "cmd-1";
        return {
          id,
          events: new ReadableStream({
            start(controller) {
              controller.enqueue({
                id,
                seq: 1,
                name: "stdout",
                value: new TextEncoder().encode("starting\n"),
              });
              finish = () => {
                controller.enqueue({ id, seq: 2, name: "exit", code: 0 });
                controller.close();
              };
            },
          }),
        };
      };
      connection.rpc.shell.killExec = async () => {
        markKilled();
        finish?.();
      };
      return connection;
    },
  };
  return { backend, killed, release: () => finish?.() };
}

describe("createTanStackTools", () => {
  it("returns a list, the shape every TanStack entry point takes", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });

    // chat(), mergeAgentTools and createToolRegistry all call array
    // methods on what they are given, so an array is the contract.
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "delete",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("keys the tools by name when asked", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });
    const set = createTanStackTools({ workspace: makeWorkspace(), format: "object" });

    expect(Array.isArray(set)).toBe(false);
    expect(Object.keys(set).sort()).toEqual(tools.map((tool) => tool.name).sort());
    for (const [name, tool] of Object.entries(set)) {
      expect(tool.name).toBe(name);
    }
  });

  it("omits mutating tools when readonly", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), readonly: true });

    expect(tools.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("passes the Zod schema through untouched for standard-schema validation", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), format: "object" });

    const schema = tools.write.inputSchema as unknown as {
      "~standard": { version: number };
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema["~standard"].version).toBe(1);
    expect(schema.safeParse({ path: "/w/a.txt", content: "x" }).success).toBe(true);
    expect(schema.safeParse({ path: "/w/a.txt" }).success).toBe(false);
  });

  it("flags only the requested tools as needing approval", () => {
    const tools = createTanStackTools({
      workspace: makeWorkspace(),
      approve: ["delete"],
      format: "object",
    });

    expect(tools.delete.needsApproval).toBe(true);
    expect(tools.write.needsApproval).toBeUndefined();
  });

  it("gates every mutating tool from one keyword", () => {
    const tools = createTanStackTools({
      workspace: makeWorkspace(),
      approve: "mutating",
      format: "object",
    });

    for (const name of ["write", "edit", "delete"]) {
      expect(tools[name].needsApproval).toBe(true);
    }
    // Reads and searches change nothing, so they run unattended.
    for (const name of ["read", "ls", "find", "grep"]) {
      expect(tools[name].needsApproval).toBeUndefined();
    }
  });

  it("describes output shapes including the error branch", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), format: "object" });

    const schema = tools.write.outputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ path: "/w/a.txt", bytesWritten: 3 }).success).toBe(true);
    expect(schema.safeParse({ path: "/w/a.txt" }).success).toBe(false);
    // TanStack validates every return against this, failures included.
    expect(schema.safeParse({ error: "read-only filesystem" }).success).toBe(true);
    // A paged listing has no fixed success shape worth asserting.
    expect(tools.ls.outputSchema).toBeUndefined();
  });

  it("returns the real reason when a mutating tool fails", async () => {
    const workspace = makeWorkspace();
    workspace.fs.writeFile = async () => {
      throw new Error("read-only filesystem");
    };
    const tools = createTanStackTools({ workspace, format: "object" });

    const result = (await tools.write.execute({
      path: "/workspace/a.txt",
      content: "hi",
    } as never)) as { error: string };

    expect(result.error).toContain("read-only filesystem");
    const schema = tools.write.outputSchema as unknown as {
      parse: (v: unknown) => unknown;
    };
    expect(schema.parse(result)).toEqual({ error: expect.stringContaining("read-only") });
  });

  it("marks tools lazy so they stay out of the prompt until discovered", () => {
    const all = createTanStackTools({
      workspace: makeWorkspace(),
      lazy: "all",
      format: "object",
    });
    expect(all.read.lazy).toBe(true);
    expect(all.write.lazy).toBe(true);

    const some = createTanStackTools({
      workspace: makeWorkspace(),
      lazy: ["grep"],
      format: "object",
    });
    expect(some.grep.lazy).toBe(true);
    expect(some.read.lazy).toBeUndefined();
  });

  it("returns plain text for a complete read and objects for structured results", async () => {
    const workspace = makeWorkspace();
    const tools = createTanStackTools({ workspace, format: "object" });

    await tools.write.execute({ path: "/w/a.txt", content: "hi\n" } as never);

    await expect(tools.read.execute({ path: "/w/a.txt" } as never)).resolves.toBe("hi");
    await expect(tools.ls.execute({ path: "/w" } as never)).resolves.toMatchObject({
      path: "/w",
      count: 1,
    });
  });

  it("returns an error object for a failed call", async () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), format: "object" });

    const result = (await tools.read.execute({ path: "/w/missing.txt" } as never)) as {
      error: string;
    };

    expect(result.error).toContain("missing.txt");
  });

  it("returns an image read as content parts TanStack attaches", async () => {
    // chat() passes a tool result through as multimodal content only when
    // it is a ContentPart array; anything else becomes JSON text.
    const workspace = makeWorkspace();
    const tools = createTanStackTools({ workspace, format: "object" });
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/pixel.png", png);

    const result = await tools.read.execute({ path: "/workspace/pixel.png" } as never);

    expect(result).toEqual([
      { type: "text", content: expect.stringContaining("/workspace/pixel.png") },
      {
        type: "image",
        source: { type: "data", value: expect.any(String), mimeType: "image/png" },
      },
    ]);
    expect(isContentPartArray(result)).toBe(true);
  });

  it("offers the backends `shell` lists and defaults to one", () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        streamingCommandBackend([]) as never,
        new WorkerJavaScriptBackend({ loader: { load: () => ({ getEntrypoint: () => ({}) }) } }),
      ],
    });
    const shell = {
      backends: {
        shell: { description: "fast shell" },
        "worker-javascript": { description: "isolate JavaScript" },
      },
      defaultBackend: "shell",
    };
    const tools = createTanStackTools({ workspace, shell, format: "object" });
    const schema = z.toJSONSchema(tools.exec.inputSchema) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
    };

    expect(schema.properties.backend?.enum).toEqual(["shell", "worker-javascript"]);
    expect(schema.required ?? []).not.toContain("backend");
    expect(schema.properties).toHaveProperty("input");
    expect(createTanStackTools({ workspace }).map((t) => t.name)).not.toContain("exec");
  });

  it("settles a streaming exec tool on its terminal snapshot", async () => {
    // TanStack tools return one value, so a streaming executor has to
    // collapse to the run's terminal snapshot rather than a mid-run one.
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        streamingCommandBackend([
          { id: "cmd-1", seq: 1, name: "stdout", value: new TextEncoder().encode("hello\n") },
          { id: "cmd-1", seq: 2, name: "exit", code: 0 },
        ]) as never,
      ],
    });
    const tools = createTanStackTools({
      workspace,
      shell: { backends: { shell: { description: "fast shell" } }, defaultBackend: "shell" },
      format: "object",
    });

    await expect(tools.exec.execute({ command: "echo hello" } as never)).resolves.toEqual({
      command: "echo hello",
      cwd: null,
      backend: "shell",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    await workspace.close();
  });

  it("forwards pre-terminal snapshots as custom events when asked", async () => {
    const events: Array<{ name: string; value: Record<string, unknown> }> = [];
    // The last snapshot settles as the return value; earlier ones are
    // emitted, so a UI can show output while the command runs.
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        streamingCommandBackend([
          { id: "cmd-1", seq: 1, name: "stdout", value: new TextEncoder().encode("partial\n") },
          { id: "cmd-1", seq: 2, name: "exit", code: 0 },
        ]) as never,
      ],
    });
    const tools = createTanStackTools({
      workspace,
      shell: { backends: { shell: { description: "fast shell" } }, defaultBackend: "shell" },
      streamEventName: "exec-progress",
      format: "object",
    });

    const result = await tools.exec.execute({ command: "echo partial" } as never, {
      toolCallId: "call-1",
      emitCustomEvent: (name, value) => events.push({ name, value }),
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: "partial\n" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].name).toBe("exec-progress");
    await workspace.close();
  });

  it("emits a running snapshot before the command produces more output", async () => {
    const quiet = quietCommandBackend();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [quiet.backend as never],
    });
    const tools = createTanStackTools({
      workspace,
      shell: { backends: { shell: { description: "fast shell" } }, defaultBackend: "shell" },
      streamEventName: "exec-progress",
      format: "object",
    });
    let firstEvent: () => void = () => {};
    const emitted = new Promise<void>((resolve) => {
      firstEvent = resolve;
    });
    const events: Array<Record<string, unknown>> = [];

    const pending = tools.exec.execute({ command: "build" } as never, {
      toolCallId: "call-1",
      emitCustomEvent: (_name, value) => {
        events.push(value);
        firstEvent();
      },
    });
    await emitted;

    expect(events[0]).toMatchObject({
      toolCallId: "call-1",
      snapshot: { exitCode: null, stdout: "starting\n" },
    });
    quiet.release();
    expect(await pending).toMatchObject({ exitCode: 0 });
    // The terminal snapshot is returned, not emitted.
    expect(
      events.every((event) => (event.snapshot as { exitCode: unknown }).exitCode === null),
    ).toBe(true);
    await workspace.close();
  });

  it("kills exec when the chat run's abort signal fires", async () => {
    const quiet = quietCommandBackend();
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [quiet.backend as never],
    });
    const tools = createTanStackTools({
      workspace,
      shell: { backends: { shell: { description: "fast shell" } }, defaultBackend: "shell" },
      format: "object",
    });
    const controller = new AbortController();

    const pending = tools.exec.execute({ command: "npm test" } as never, {
      toolCallId: "call-1",
      abortSignal: controller.signal,
    });
    controller.abort();

    await quiet.killed;
    await pending;
    await workspace.close();
  });
});
