import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { WorkspaceModuleBackend } from "../../runtime/types";
import { Workspace } from "../../workspace";
import { defineExec, type ExecToolOutput, type ExecWorkspaceLike } from "./exec";
import { resolveToolOptions } from "./options";

// A runtime that records the metadata each run was started with.
function recordingWorkspace(): { workspace: ExecWorkspaceLike; metadata: unknown[] } {
  const metadata: unknown[] = [];
  const workspace: ExecWorkspaceLike = {
    runtime: {
      async exec(_command, options) {
        metadata.push(options.metadata);
        return {
          result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        };
      },
      backends: () => [{ id: "sh", protocol: "command", callable: false }],
    },
  };
  return { workspace, metadata };
}

async function last(output: AsyncIterable<ExecToolOutput>): Promise<ExecToolOutput | undefined> {
  let value: ExecToolOutput | undefined;
  for await (const chunk of output) value = chunk;
  return value;
}

describe("defineExec metadata", () => {
  it("starts each run with the metadata it was given", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace, metadata: { conversation: "c1" } });

    await last(exec.execute({ command: "true" }));

    expect(metadata).toEqual([{ conversation: "c1" }]);
  });

  it("picks each run's metadata from its tool call's id", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({
      workspace,
      metadata: ({ toolCallId }) => ({ toolCall: toolCallId }),
    });

    await last(exec.execute({ command: "true" }, { toolCallId: "call-1" }));
    await last(exec.execute({ command: "true" }, { toolCallId: "call-2" }));

    expect(metadata).toEqual([{ toolCall: "call-1" }, { toolCall: "call-2" }]);
  });

  it("uses the metadata a call passes instead", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace, metadata: { conversation: "configured" } });

    await last(exec.execute({ command: "true" }, { metadata: { conversation: "passed" } }));

    expect(metadata).toEqual([{ conversation: "passed" }]);
  });

  it("starts runs without metadata when none is given", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace });

    await last(exec.execute({ command: "true" }));

    expect(metadata).toEqual([undefined]);
  });

  it("reports a failure to pick metadata as the call's error, without running", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({
      workspace,
      metadata: () => {
        throw new Error("no conversation");
      },
    });

    await expect(last(exec.execute({ command: "true" }))).resolves.toEqual({
      command: "true",
      cwd: null,
      backend: "sh",
      error: "no conversation",
    });
    expect(metadata).toEqual([]);
  });
});

describe("defineExec result bound", () => {
  it("saves a return value past the output limit to a file", async () => {
    const written: Array<{ path: string; size: number }> = [];
    const big = "x".repeat(200_000);
    const workspace: ExecWorkspaceLike = {
      runtime: {
        async exec() {
          return { result: async () => ({ exitCode: 0, stdout: "", stderr: "", value: big }) };
        },
        backends: () => [{ id: "js", protocol: "module", callable: true }],
        async saveResult(name, content) {
          const path = `/out/${name}.result.json`;
          written.push({ path, size: content.length });
          return { saved: true, path };
        },
      },
    };
    const exec = defineExec({ workspace });
    const out = (await last(exec.execute({ command: "x" }, { toolCallId: "call1" }))) as {
      result: { truncated: boolean; path: string; preview: string };
    };
    expect(JSON.stringify(out).length).toBeLessThan(20_000);
    expect(out.result.truncated).toBe(true);
    expect(written).toEqual([{ path: out.result.path, size: 200_002 }]);
    expect(out.result.path).toMatch(/call1\.result\.json$/);
  });

  it("keeps a small return value whole", async () => {
    const workspace: ExecWorkspaceLike = {
      runtime: {
        async exec() {
          return { result: async () => ({ exitCode: 0, stdout: "", stderr: "", value: { a: 1 } }) };
        },
        backends: () => [{ id: "js", protocol: "module", callable: true }],
      },
    };
    const out = (await last(defineExec({ workspace }).execute({ command: "x" }))) as {
      result: unknown;
    };
    expect(out.result).toEqual({ a: 1 });
  });
});

// A callable module backend whose every run returns `value`.
function returningBackend(value: string): WorkspaceModuleBackend {
  let runs = 0;
  const events = (id: string) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue({ id, seq: 1, name: "exit", code: 0, result: value });
        controller.close();
      },
    });
  return {
    protocol: "module",
    id: "js",
    type: "test",
    callable: true,
    connect: async () => ({
      async exec(input) {
        runs += 1;
        const id = input.id ?? `run-${runs}`;
        return { id, events: events(id) };
      },
      async getExec(input) {
        return { id: input.id, events: events(input.id) };
      },
      async killExec() {},
      async disposeExec() {},
    }),
  };
}

function execOptionsOf(tools: ReturnType<typeof resolveToolOptions>) {
  if (tools.exec === undefined) throw new Error("tool set has no exec");
  return tools.exec;
}

describe("defineExec result saved by the Workspace", () => {
  it("saves under the Workspace output dir, readable through a rooted tool set", async () => {
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [returningBackend("y".repeat(200_000))],
      output: { dir: "/workspace/.output" },
    });
    const tools = resolveToolOptions({ workspace: ws, root: "/workspace" });
    const exec = defineExec(execOptionsOf(tools));
    const out = (await last(exec.execute({ command: "x" }, { toolCallId: "call1" }))) as {
      result: { path: string };
    };
    expect(out.result.path).toBe("/workspace/.output/call1.result.json");
    const saved = await tools.read.store.readAll(out.result.path);
    expect(saved?.length).toBe(200_002);
  });

  it("prunes saved results with the Workspace's keep", async () => {
    let now = 0;
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [returningBackend("y".repeat(200_000))],
      now: () => (now += 1000),
      output: { dir: "/logs", keep: 2 },
    });
    const exec = defineExec(execOptionsOf(resolveToolOptions({ workspace: ws })));
    for (const id of ["a", "b", "c"]) {
      await last(exec.execute({ command: "x" }, { toolCallId: id }));
    }
    const names = (await ws.fs.readdir("/logs")).map((entry) => entry.name).sort();
    expect(names).toEqual(["b.result.json", "c.result.json"]);
  });
});
