import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createToolBindings } from "../../modules/tools.js";
import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../../runtime/types.js";
import { Workspace } from "../../workspace.js";
import { createPiTools, forPiTools, type PiAgentTool, type PiAgentToolResult } from "./index.js";

// SAFETY: Tool bindings never touch the host's Git, Artifacts, or runtime.
const host = {} as WorkspaceModuleHost;

function callContext(): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    resolvePath: async (path) => path,
  };
}

const pathParameters = {
  type: "object" as const,
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

// A pi agent tool that records what reached it and answers with `result`.
function agentTool(name: string, result: PiAgentToolResult, extra: Partial<PiAgentTool> = {}) {
  const seen: { callId: string; params: unknown; signal: AbortSignal | undefined }[] = [];
  const tool: PiAgentTool = {
    name,
    description: `The ${name} tool.`,
    parameters: pathParameters,
    async execute(callId, params, signal) {
      seen.push({ callId, params, signal });
      return result;
    },
    ...extra,
  };
  return { tool, seen };
}

function bindingFor(source: ReturnType<typeof forPiTools>, name: string) {
  const binding = [...source()].find((candidate) => candidate.name === name);
  if (!binding) throw new Error(`no ${name} binding`);
  return binding;
}

describe("forPiTools", () => {
  it("prepares, validates, then runs a tool with a call id and the call's signal", async () => {
    const order: string[] = [];
    const { tool, seen } = agentTool(
      "read",
      { content: [{ type: "text", text: "hello" }], details: { bytes: 5 } },
      {
        prepareArguments(args) {
          order.push("prepare");
          return { ...(args as object), path: "prepared.txt" };
        },
      },
    );
    const context = callContext();
    const result = await bindingFor(
      forPiTools([tool], {
        validate(candidate, call) {
          order.push("validate");
          expect(candidate).toBe(tool);
          return validateToolArguments(candidate, call);
        },
      }),
      "read",
    ).call({ path: "raw.txt" }, context);

    expect(order).toEqual(["prepare", "validate"]);
    expect(seen).toEqual([
      {
        callId: expect.stringMatching(/^ws-tools-/),
        params: { path: "prepared.txt" },
        signal: context.signal,
      },
    ]);
    expect(result).toEqual({ text: "hello", details: { bytes: 5 }, isError: false });
  });

  it("rejects a call that fails validation without running the tool", async () => {
    const { tool, seen } = agentTool("read", { content: [] });
    const binding = bindingFor(forPiTools([tool], { validate: validateToolArguments }), "read");

    await expect(binding.call({ file: "a.txt" }, callContext())).rejects.toThrow(
      'Validation failed for tool "read"',
    );
    expect(seen).toEqual([]);
  });

  it("passes arguments through unchecked when no validator is given", async () => {
    const { tool, seen } = agentTool("read", { content: [] });
    await bindingFor(forPiTools([tool]), "read").call({ anything: [1, 2] }, callContext());
    expect(seen[0]?.params).toEqual({ anything: [1, 2] });
  });

  it("joins text parts, names images, and keeps the error flag and structured content", async () => {
    const { tool } = agentTool("screenshot", {
      content: [
        { type: "text", text: "Captured the page." },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: "It is mostly blue." },
      ],
      details: undefined,
      structuredContent: { width: 800 },
      isError: true,
    });
    await expect(
      bindingFor(forPiTools([tool]), "screenshot").call({ path: "x" }, callContext()),
    ).resolves.toEqual({
      text: "Captured the page.\n[image: image/png]\nIt is mostly blue.",
      details: null,
      structuredContent: { width: 800 },
      isError: true,
    });
  });

  it("lets a tool's own failure reject the call", async () => {
    const { tool } = agentTool("read", { content: [] });
    tool.execute = async () => {
      throw new Error("disk on fire");
    };
    await expect(
      bindingFor(forPiTools([tool]), "read").call({ path: "x" }, callContext()),
    ).rejects.toThrow("disk on fire");
  });

  it("reads a function of tools each time its bindings are taken", () => {
    let tools = [agentTool("read", { content: [] }).tool];
    const source = forPiTools(() => tools);
    expect([...source()].map((binding) => binding.name)).toEqual(["read"]);
    tools = [...tools, agentTool("grep", { content: [] }).tool];
    expect([...source()].map((binding) => binding.name)).toEqual(["read", "grep"]);
  });

  it("serves pi tools as ws:tools exports, leaving out exec", async () => {
    const read = agentTool("read", { content: [{ type: "text", text: "contents" }] });
    const exec = agentTool("exec", { content: [] });
    const functions = createToolBindings(
      forPiTools(() => [read.tool, exec.tool], { validate: validateToolArguments }),
    )(host);

    expect(Object.keys(functions)).toEqual(["read"]);
    await expect(functions.read?.([{ path: "a.txt" }], callContext())).resolves.toEqual({
      text: "contents",
      details: null,
      isError: false,
    });
  });

  it("serves the tools createPiTools makes over a Workspace", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      now: () => 1_700_000_000_000,
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/notes.txt", "remember the milk\n");
    const functions = createToolBindings(forPiTools(createPiTools({ workspace })))(host);

    expect(Object.keys(functions).sort()).toEqual([
      "delete",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    const found = (await functions.grep?.(
      [{ query: "milk", path: "/workspace" }],
      callContext(),
    )) as {
      text: string;
      isError: boolean;
    };
    expect(found.isError).toBe(false);
    expect(found.text).toContain("notes.txt");
    // createPiTools reports a bad call as an error result rather than throwing.
    await expect(functions.read?.([{}], callContext())).resolves.toMatchObject({ isError: true });
  });
});
