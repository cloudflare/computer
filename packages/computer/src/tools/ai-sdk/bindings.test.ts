import { type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { WorkspaceModuleCallContext } from "../../runtime/types.js";
import { forAISDKTools } from "./bindings.js";

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
});
