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
function recording(name: string) {
  const calls: { input: unknown; context: WorkspaceModuleCallContext }[] = [];
  const binding: ToolBinding = {
    name,
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

  it("names a tool whose name cannot be an export, and how to leave it out", () => {
    const factory = createToolBindings([
      recording("read").binding,
      recording("list-files").binding,
    ]);
    expect(() => factory(host)).toThrow(
      'Tool "list-files" cannot be exported from ws:tools: export names must be JavaScript identifiers, and not "default" or "then". Leave it out with the exclude option.',
    );
  });

  it("refuses two tools with the same name", () => {
    const factory = createToolBindings([recording("read").binding, recording("read").binding]);
    expect(() => factory(host)).toThrow('Two tools are named "read".');
  });

  it("describes the module for a model, saying which tools are left out", () => {
    expect(createToolBindings([]).description).toBe(
      "The agent's own tools, callable from code, under the same names. Each takes one object of the tool's arguments and returns `{ text, details, isError }`. There is no `exec` export: importing it fails.",
    );
    expect(createToolBindings([], { exclude: [] }).description).toBe(
      "The agent's own tools, callable from code, under the same names. Each takes one object of the tool's arguments and returns `{ text, details, isError }`.",
    );
    expect(createToolBindings([], { description: "Custom." }).description).toBe("Custom.");
  });
});
