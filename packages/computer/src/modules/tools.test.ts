import { describe, expect, it } from "vitest";

import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../runtime/types.js";
import { createToolsModule, type ModuleTool } from "./tools.js";

function callContext(signal = new AbortController().signal): WorkspaceModuleCallContext {
  return {
    signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    resolvePath: async (path) => path,
  };
}

function tool(name: string, calls: unknown[] = []): ModuleTool {
  return {
    name,
    async execute(args) {
      calls.push(args);
      return { tool: name, args };
    },
  };
}

// SAFETY: The module uses nothing from the host.
const host = {} as WorkspaceModuleHost;

describe("createToolsModule", () => {
  it("exports each tool under its own name", async () => {
    const calls: unknown[] = [];
    const functions = createToolsModule(() => [tool("read", calls), tool("grep")])(host);

    expect(Object.keys(functions)).toEqual(["read", "grep"]);
    await expect(functions.read?.([{ path: "a" }], callContext())).resolves.toEqual({
      tool: "read",
      args: { path: "a" },
    });
    await functions.read?.([], callContext());
    expect(calls).toEqual([{ path: "a" }, {}]);
  });

  it("leaves out excluded tools and names that cannot be exports", () => {
    const functions = createToolsModule(
      () => [tool("exec"), tool("web-fetch"), tool("then"), tool("ls")],
      { exclude: ["exec"] },
    )(host);

    expect(Object.keys(functions)).toEqual(["ls"]);
  });

  it("lists the tools when it is described, not when it is built", () => {
    let names = ["read"];
    const module = createToolsModule(() => names.map((name) => tool(name)), { exclude: ["exec"] });

    expect(module.description).toContain("Exports `read`.");
    names = ["read", "grep", "exec"];
    expect(module.description).toContain("Exports `read`, `grep`.");
    expect(module.description).toContain("There is no `exec` export.");
  });

  it.each([
    [[1], /must be an object/],
    [[[1]], /must be an object/],
    [[{}, {}], /takes one object/],
  ])("rejects %j", async (args, message) => {
    const calls: unknown[] = [];
    const functions = createToolsModule(() => [tool("read", calls)])(host);

    await expect(functions.read?.(args as never, callContext())).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("does not run a tool once the call is cancelled", async () => {
    const calls: unknown[] = [];
    const functions = createToolsModule(() => [tool("read", calls)])(host);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(functions.read?.([{}], callContext(abort.signal))).rejects.toThrow("cancelled");
    expect(calls).toEqual([]);
  });
});
