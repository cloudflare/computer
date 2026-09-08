// Unit tests for the framework-agnostic `js` tool definition: generated
// description, JSON Schema shape, session routing, input validation, and
// the shared text renderer. Real eval behavior is covered by the workerd
// integration suites; here the workspace is a recording fake.

import { describe, expect, it } from "vitest";

import { capability, fetchCapability } from "./capability.js";
import { createJsToolDefinition, type JsToolOptions, renderJsResultText } from "./tool.js";
import type { ReplExecutionResult } from "./types.js";

interface ReplCall {
  name: string;
  options: Record<string, unknown>;
  code?: string;
}

function fakeWorkspace(calls: ReplCall[]) {
  return {
    repl(name: string, options: Record<string, unknown>) {
      const call: ReplCall = { name, options };
      calls.push(call);
      return {
        eval(code: string): Promise<ReplExecutionResult> {
          call.code = code;
          return Promise.resolve({
            code,
            value: `ran in ${name}`,
            logs: { entries: [] },
            results: [],
            executionCount: 1,
          });
        },
      };
    },
  };
}

const LOADER = {} as JsToolOptions["loader"];

function makeTool(overrides: Partial<JsToolOptions> = {}) {
  const calls: ReplCall[] = [];
  const definition = createJsToolDefinition({
    workspace: fakeWorkspace(calls),
    loader: LOADER,
    ...overrides,
  });
  return { definition, calls };
}

describe("createJsToolDefinition", () => {
  it("describes persistence, built-ins, and each grant with its description", () => {
    const { definition } = makeTool({
      capabilities: {
        weather: capability({ get: () => 1 }, { description: "Weather lookups" }),
        fetch: fetchCapability({ allow: ["api.example.com"] }),
        bare: capability(() => 0),
      },
    });
    expect(definition.name).toBe("js");
    expect(definition.description).toContain("persistent");
    expect(definition.description).toContain("emit(value)");
    expect(definition.description).toContain('session "main"');
    expect(definition.description).toContain("weather (Weather lookups)");
    expect(definition.description).toContain("fetch (HTTP fetch restricted to: api.example.com)");
    expect(definition.description).toContain("bare");
    expect(definition.description).toContain('help("name")');
  });

  it("says so when nothing is granted", () => {
    const { definition } = makeTool();
    expect(definition.description).toContain("No capabilities are granted");
    expect(definition.description).toContain("help()");
  });

  it("names the configured default session in description and schema", () => {
    const { definition } = makeTool({
      defaultSession: "scratch",
      capabilities: { weather: capability({ get: () => 1 }) },
    });
    expect(definition.description).toContain('session "scratch"');
    expect(JSON.stringify(definition.inputSchema)).toContain('\\"scratch\\"');
  });

  it("exposes a plain JSON Schema requiring only code", () => {
    const { definition } = makeTool();
    expect(definition.inputSchema.type).toBe("object");
    expect(definition.inputSchema.required).toEqual(["code"]);
    expect(definition.inputSchema.additionalProperties).toBe(false);
    const code = definition.inputSchema.properties.code as { type: string };
    const sessionName = definition.inputSchema.properties.sessionName as { type: string };
    expect(code.type).toBe("string");
    expect(sessionName.type).toBe("string");
  });

  it("routes to the default session and forwards grants and limits", async () => {
    const weather = capability({ get: () => 1 });
    const { definition, calls } = makeTool({
      capabilities: { weather },
      timeoutMs: 5_000,
      maxEffectBytes: 1_024,
    });
    const result = await definition.run({ code: "1 + 1" });
    expect(result.value).toBe("ran in main");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("main");
    expect(calls[0].code).toBe("1 + 1");
    expect(calls[0].options).toEqual({
      loader: LOADER,
      capabilities: { weather },
      timeoutMs: 5_000,
      maxEffectBytes: 1_024,
    });
  });

  it("routes sessionName overrides and omits unset limits", async () => {
    const { definition, calls } = makeTool();
    const result = await definition.run({ code: "2", sessionName: "notes" });
    expect(result.value).toBe("ran in notes");
    expect(calls[0].name).toBe("notes");
    expect(calls[0].options).toEqual({ loader: LOADER, capabilities: {} });
  });

  it("rejects caller mistakes with TypeErrors", async () => {
    const { definition } = makeTool();
    await expect(definition.run({ code: 1 as unknown as string })).rejects.toThrow(TypeError);
    await expect(definition.run({ code: "1", sessionName: "" })).rejects.toThrow(TypeError);
    expect(() => createJsToolDefinition({
      workspace: fakeWorkspace([]),
      loader: LOADER,
      defaultSession: "",
    })).toThrow(TypeError);
  });
});

describe("renderJsResultText", () => {
  const base = { code: "", logs: { entries: [] }, results: [], executionCount: 1 };

  it("renders logs, emits, and value in execution order", () => {
    const text = renderJsResultText({
      ...base,
      value: { total: 3 },
      logs: { entries: [{ level: "warn" as const, text: "careful" }], dropped: 2 },
      results: [{ text: "emitted-one", value: 1 }],
    });
    expect(text).toBe(
      '[warn] careful\n(2 more log entries dropped)\nemitted-one\nvalue: {"total":3}',
    );
  });

  it("renders structured errors with kind and traceback", () => {
    const text = renderJsResultText({
      ...base,
      error: {
        name: "StaleLeaseError",
        message: "handle died",
        kind: "stale-lease",
        traceback: "at cell:1",
      },
    });
    expect(text).toBe("StaleLeaseError [stale-lease]: handle died\nat cell:1");
  });

  it("renders undefined and unstringifiable values honestly", () => {
    expect(renderJsResultText({ ...base, value: undefined })).toBe("value: undefined");
    expect(renderJsResultText({ ...base, value: 10n })).toBe('value: "10n"');
    expect(renderJsResultText(base)).toBe("value: undefined");
  });
});
