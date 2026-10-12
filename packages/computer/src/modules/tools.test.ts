import { describe, expect, it } from "vitest";

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
} from "../runtime/types.js";
import { createToolBindings, type ToolBinding } from "./tools.js";

// SAFETY: Tool bindings never touch the host's Git, Artifacts, or runtime.
const host = {} as WorkspaceModuleHost;

function callContext(
  overrides: Partial<WorkspaceModuleCallContext> = {},
): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    resolvePath: async (path) => path,
    ...overrides,
  };
}

// A binding that records each call and echoes its input back as details.
function recording(name: string, options: { readOnly?: boolean } = {}) {
  const calls: { input: unknown; context: WorkspaceModuleCallContext }[] = [];
  const binding: ToolBinding = {
    name,
    ...options,
    call(input, context) {
      calls.push({ input, context });
      return { text: `${name} ran`, details: input, isError: false };
    },
  };
  return { binding, calls };
}

function call(functions: WorkspaceModuleFunctions, name: string, args: unknown[]) {
  const fn = functions[name];
  if (!fn) throw new Error(`no export ${name}`);
  // SAFETY: Tests pass values the isolate could send, and some it should not.
  return fn(args as never, callContext());
}

describe("createToolBindings", () => {
  it("exports each tool under its own name and passes the call through", async () => {
    const read = recording("read");
    const grep = recording("grep");
    const functions = createToolBindings([read.binding, grep.binding])(host);

    expect(Object.keys(functions).sort()).toEqual(["grep", "read"]);
    const context = callContext();
    await expect(functions.read?.([{ path: "a.txt" }], context)).resolves.toEqual({
      text: "read ran",
      details: { path: "a.txt" },
      isError: false,
    });
    expect(read.calls).toEqual([{ input: { path: "a.txt" }, context }]);
    expect(grep.calls).toEqual([]);
  });

  it("leaves out exec by default so a run cannot start runs", () => {
    const functions = createToolBindings([recording("exec").binding, recording("read").binding])(
      host,
    );
    expect(Object.keys(functions)).toEqual(["read"]);
  });

  it("leaves out the tools named in exclude instead of exec", () => {
    const functions = createToolBindings(
      [recording("exec").binding, recording("read").binding, recording("write").binding],
      { exclude: ["write"] },
    )(host);
    expect(Object.keys(functions).sort()).toEqual(["exec", "read"]);
  });

  it("reads a function of tools each time a backend connects", () => {
    let tools = [recording("read").binding];
    const factory = createToolBindings(() => tools);

    expect(Object.keys(factory(host))).toEqual(["read"]);
    tools = [recording("read").binding, recording("grep").binding];
    expect(Object.keys(factory(host)).sort()).toEqual(["grep", "read"]);
  });

  it("refuses a tool that may write on a read-only backend, before running it", async () => {
    const write = recording("write");
    const functions = createToolBindings([write.binding])(host);
    await expect(
      functions.write?.([{ path: "a.txt", content: "x" }], callContext({ access: "read" })),
    ).rejects.toThrow("ws:tools write requires Workspace write access.");
    expect(write.calls).toEqual([]);
  });

  it("runs a tool marked readOnly on a read-only backend", async () => {
    const read = recording("read", { readOnly: true });
    const functions = createToolBindings([read.binding])(host);
    await expect(
      functions.read?.([{ path: "a.txt" }], callContext({ access: "read" })),
    ).resolves.toMatchObject({ text: "read ran" });
  });

  it("treats a call with no arguments as an empty object", async () => {
    const read = recording("read");
    await call(createToolBindings([read.binding])(host), "read", []);
    expect(read.calls[0]?.input).toEqual({});
  });

  it.each([
    ["two arguments", [{ path: "a" }, { path: "b" }]],
    ["an array", [["a"]]],
    ["null", [null]],
    ["a string", ["a.txt"]],
  ])("refuses %s, since every tool takes one object", async (_label, args) => {
    const read = recording("read");
    const functions = createToolBindings([read.binding])(host);
    await expect(async () => call(functions, "read", args)).rejects.toThrow(
      "read(arguments) takes one object of the tool's arguments.",
    );
    expect(read.calls).toEqual([]);
  });

  it.each([
    ["list-files", "list_files"],
    ["github.search issues", "github_search_issues"],
    ["mcp:fetch!", "mcpfetch"],
    ["3d", "_3d"],
    ["default", "default_"],
    ["then", "then_"],
    ["delete", "delete"],
  ])("exports %s as %s, and calls the tool by its own name", async (toolName, exported) => {
    const tool = recording(toolName);
    const functions = createToolBindings([tool.binding])(host);
    expect(Object.keys(functions)).toEqual([exported]);
    await expect(call(functions, exported, [{}])).resolves.toMatchObject({
      text: `${toolName} ran`,
    });
  });

  it("refuses two tools that share an export name", () => {
    const factory = createToolBindings([
      recording("list-files").binding,
      recording("list_files").binding,
    ]);
    expect(() => factory(host)).toThrow('Two tools are exported as "list_files".');
  });

  it("describes the module for a model, saying which tools are left out", () => {
    expect(createToolBindings([]).description).toBe(
      "The agent's own tools, callable from code. Each is exported under its name, with characters an identifier cannot hold turned into `_` (`list-files` becomes `list_files`), takes one object of the tool's arguments, and returns `{ text, details, isError }`. There is no `exec` export: importing it fails.",
    );
    expect(createToolBindings([], { exclude: [] }).description).toBe(
      "The agent's own tools, callable from code. Each is exported under its name, with characters an identifier cannot hold turned into `_` (`list-files` becomes `list_files`), takes one object of the tool's arguments, and returns `{ text, details, isError }`.",
    );
    expect(createToolBindings([], { description: "Custom." }).description).toBe("Custom.");
  });
});
