import { type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";

import type { WorkspaceModuleCallContext } from "../../runtime/types.js";
import { Workspace } from "../../workspace.js";
import { forAISDKTools } from "./bindings.js";
import { createAITools } from "./index.js";

function callContext(): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    resolvePath: async (path) => path,
  };
}

function bindingFor(source: ReturnType<typeof forAISDKTools>, name: string) {
  const binding = [...source()].find((candidate) => candidate.name === name);
  if (!binding) throw new Error(`no ${name} binding`);
  return binding;
}

describe("forAISDKTools", () => {
  it("runs a tool with the code's arguments, a call id, and the call's signal", async () => {
    const seen: unknown[] = [];
    const tools = {
      weather: tool({
        description: "Weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async (input, options) => {
          seen.push({ input, toolCallId: options.toolCallId, signal: options.abortSignal });
          return { forecast: "sunny" };
        },
      }),
    };
    const context = callContext();

    const result = await bindingFor(forAISDKTools(tools), "weather").call(
      { city: "Lisbon" },
      context,
    );

    expect(seen).toEqual([
      {
        input: { city: "Lisbon" },
        toolCallId: expect.stringMatching(/^ws-tools-/),
        signal: context.signal,
      },
    ]);
    expect(result).toEqual({
      text: '{"forecast":"sunny"}',
      details: { forecast: "sunny" },
      isError: false,
    });
  });

  it("returns a string result as text, and the last value of a streaming tool", async () => {
    const tools = {
      echo: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => value,
      }),
      count: tool({
        inputSchema: z.object({}),
        async *execute() {
          yield "one";
          yield "two";
        },
      }),
    };
    await expect(
      bindingFor(forAISDKTools(tools), "echo").call({ value: "hi" }, callContext()),
    ).resolves.toEqual({ text: "hi", details: "hi", isError: false });
    await expect(
      bindingFor(forAISDKTools(tools), "count").call({}, callContext()),
    ).resolves.toEqual({ text: "two", details: "two", isError: false });
  });

  it("checks the arguments against the tool's schema, and runs it with the parsed value", async () => {
    const seen: unknown[] = [];
    const tools = {
      grep: tool({
        inputSchema: z.object({ query: z.string(), path: z.string().default("/workspace") }),
        execute: async (input) => {
          seen.push(input);
          return "found";
        },
      }),
    };
    const binding = bindingFor(forAISDKTools(tools), "grep");

    await binding.call({ query: "TODO" }, callContext());
    expect(seen).toEqual([{ query: "TODO", path: "/workspace" }]);

    await expect(binding.call({ path: 3 }, callContext())).rejects.toThrow(
      /^Invalid arguments for grep: /,
    );
    expect(seen).toHaveLength(1);
  });

  it("reports a result shaped { error: string } as a failure", async () => {
    const tools = {
      read: tool({
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => ({ error: `File not found: ${path}` }),
      }),
    };
    await expect(
      bindingFor(forAISDKTools(tools), "read").call({ path: "/missing" }, callContext()),
    ).resolves.toEqual({
      text: "File not found: /missing",
      details: { error: "File not found: /missing" },
      isError: true,
    });
  });

  it("reports a failed read from createAITools as a failure", async () => {
    const workspace = new Workspace({
      storage: new SQLiteTestStorage(),
      now: () => 1_700_000_000_000,
    });
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const result = await bindingFor(forAISDKTools(createAITools({ workspace })), "read").call(
      { path: "/workspace/missing.txt" },
      callContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("/workspace/missing.txt");
  });

  it("leaves out tools that cannot run on the server or need approval", () => {
    const tools = {
      clientOnly: tool({ inputSchema: z.object({}) }),
      launch: tool({
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => "launched",
      }),
      ok: tool({ inputSchema: z.object({}), execute: async () => "ok" }),
    };
    expect([...forAISDKTools(tools)()].map((binding) => binding.name)).toEqual(["ok"]);
  });

  it("calls the tool the function returns at call time, not when bindings were taken", async () => {
    let answer = "first";
    const source = forAISDKTools(() => ({
      answer: tool({ inputSchema: z.object({}), execute: async () => answer }),
    }));
    const binding = bindingFor(source, "answer");
    answer = "second";
    await expect(binding.call({}, callContext())).resolves.toMatchObject({ text: "second" });
  });

  it("rejects the call when the tool is gone by the time code calls it", async () => {
    let tools: ToolSet = {
      gone: tool({ inputSchema: z.object({}), execute: async () => "here" }),
    };
    const binding = bindingFor(
      forAISDKTools(() => tools),
      "gone",
    );
    tools = {};
    await expect(binding.call({}, callContext())).rejects.toThrow('No tool named "gone"');
  });
  it("gives each binding the tool's description and input schema, so ws:tools can declare it", () => {
    const binding = bindingFor(
      forAISDKTools({
        weather: tool({
          description: "The weather in a city.",
          inputSchema: z.object({ city: z.string().describe("The city.") }),
          execute: async () => "sunny",
        }),
      }),
      "weather",
    );

    expect(binding.description).toBe("The weather in a city.");
    expect(binding.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string", description: "The city." } },
      required: ["city"],
    });
  });
});
