// The AI SDK shim is a thin dress over createJsToolDefinition — these
// tests pin the seams: description and schema pass through, and execute
// routes to the definition's run().

import { describe, expect, it } from "vitest";

import type { JsToolOptions } from "../repl/tool.js";
import type { ReplExecutionResult } from "../repl/types.js";
import { createJsTool } from "./js.js";

function fakeWorkspace(calls: Array<{ name: string; code: string }>) {
  return {
    repl(name: string) {
      return {
        eval(code: string): Promise<ReplExecutionResult> {
          calls.push({ name, code });
          return Promise.resolve({
            code,
            value: 42,
            logs: { entries: [] },
            results: [],
            executionCount: 1,
          });
        },
      };
    },
  };
}

describe("createJsTool (AI SDK shim)", () => {
  it("passes the generated description and JSON Schema through", () => {
    const jsTool = createJsTool({
      workspace: fakeWorkspace([]),
      loader: {} as JsToolOptions["loader"],
    });
    expect(jsTool.description).toContain("persistent");
    const schema = jsTool.inputSchema as { jsonSchema?: { required?: string[] } };
    expect(schema.jsonSchema?.required).toEqual(["code"]);
  });

  it("executes through the definition", async () => {
    const calls: Array<{ name: string; code: string }> = [];
    const jsTool = createJsTool({
      workspace: fakeWorkspace(calls),
      loader: {} as JsToolOptions["loader"],
    });
    const result = (await jsTool.execute?.(
      { code: "6 * 7", sessionName: "notes" },
      { toolCallId: "t1", messages: [], abortSignal: new AbortController().signal },
    )) as ReplExecutionResult;
    expect(result.value).toBe(42);
    expect(calls).toEqual([{ name: "notes", code: "6 * 7" }]);
  });
});
