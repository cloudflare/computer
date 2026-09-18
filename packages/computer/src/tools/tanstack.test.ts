import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Workspace } from "../workspace.js";
import { defineTool } from "./spec.js";
import { createTanStackTools, toTanStackTools } from "./tanstack.js";

function makeWorkspace(): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), now: () => 1_700_000_000_000 });
}

// An in-process command backend that streams a fixed event sequence,
// so the exec tool runs against a real WorkspaceRuntime handle rather
// than a hand-shaped fake.
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

describe("createTanStackTools", () => {
  it("returns a record keyed by tool name", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });

    expect(Object.keys(tools).sort()).toEqual([
      "delete",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.name).toBe(name);
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("omits mutating tools when readonly", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), readonly: true });

    expect(Object.keys(tools).sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("passes the Zod schema through untouched for standard-schema validation", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });

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
    });

    expect(tools.delete.needsApproval).toBe(true);
    expect(tools.write.needsApproval).toBeUndefined();
  });

  it("gates every mutating tool from one keyword", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace(), approve: "mutating" });

    for (const name of ["write", "edit", "delete"]) {
      expect(tools[name].needsApproval).toBe(true);
    }
    // Reads and searches change nothing, so they run unattended.
    for (const name of ["read", "ls", "find", "grep"]) {
      expect(tools[name].needsApproval).toBeUndefined();
    }
  });

  it("describes output shapes including the error branch", () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });

    const schema = tools.write.outputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ path: "/w/a.txt", bytesWritten: 3 }).success).toBe(true);
    expect(schema.safeParse({ path: "/w/a.txt" }).success).toBe(false);
    // TanStack validates every return against this schema, so a
    // failure has to pass it too. A success-only schema would replace
    // the real reason with a validation complaint.
    expect(schema.safeParse({ error: "read-only filesystem" }).success).toBe(true);
    // A paged listing has no fixed success shape worth asserting.
    expect(tools.ls.outputSchema).toBeUndefined();
  });

  it("returns the real reason when a mutating tool fails", async () => {
    const workspace = makeWorkspace();
    workspace.fs.writeFile = async () => {
      throw new Error("read-only filesystem");
    };
    const tools = createTanStackTools({ workspace });

    const result = (await tools.write.execute({
      path: "/workspace/a.txt",
      content: "hi",
    } as never)) as { error: string };

    // Validating this against the tool's own outputSchema must keep the
    // message intact, which is what TanStack does with every return.
    expect(result.error).toContain("read-only filesystem");
    const schema = tools.write.outputSchema as unknown as {
      parse: (v: unknown) => unknown;
    };
    expect(schema.parse(result)).toEqual({ error: expect.stringContaining("read-only") });
  });

  it("marks tools lazy so they stay out of the prompt until discovered", () => {
    const all = createTanStackTools({ workspace: makeWorkspace(), lazy: "all" });
    expect(all.read.lazy).toBe(true);
    expect(all.write.lazy).toBe(true);

    const some = createTanStackTools({ workspace: makeWorkspace(), lazy: ["grep"] });
    expect(some.grep.lazy).toBe(true);
    expect(some.read.lazy).toBeUndefined();
  });

  it("returns plain text for a complete read and objects for structured results", async () => {
    const workspace = makeWorkspace();
    const tools = createTanStackTools({ workspace });

    await tools.write.execute({ path: "/w/a.txt", content: "hi\n" } as never);

    await expect(tools.read.execute({ path: "/w/a.txt" } as never)).resolves.toBe("hi");
    await expect(tools.ls.execute({ path: "/w" } as never)).resolves.toMatchObject({
      path: "/w",
      count: 1,
    });
  });

  it("returns an error object for a failed call", async () => {
    const tools = createTanStackTools({ workspace: makeWorkspace() });

    const result = (await tools.read.execute({ path: "/w/missing.txt" } as never)) as {
      error: string;
    };

    expect(result.error).toContain("missing.txt");
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
      shell: { defaultBackend: "shell", backends: { shell: { description: "fast shell" } } },
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
    // Exercise the event forwarding against the adapter's contract:
    // the last snapshot settles, earlier ones are emitted.
    const tools = toTanStackTools(
      {
        fake: defineTool({
          name: "fake",
          description: "d",
          inputSchema: z.object({}),
          traits: { streams: true },
          execute: async function* () {
            yield { exitCode: null, stdout: "partial" };
            yield { exitCode: 0, stdout: "complete" };
          },
        }) as never,
      },
      { streamEventName: "exec-progress" },
    );

    const result = await tools.fake.execute({} as never, {
      toolCallId: "call-1",
      emitCustomEvent: (name, value) => events.push({ name, value }),
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: "complete" });
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("exec-progress");
    expect(events[0].value.snapshot).toMatchObject({ stdout: "partial" });
  });
});
