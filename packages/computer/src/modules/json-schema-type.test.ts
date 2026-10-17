import { describe, expect, it } from "vitest";

import { acceptsNothing, jsonSchemaType } from "./json-schema-type.js";

describe("jsonSchemaType", () => {
  it.each([
    [{ type: "string" }, "string"],
    [{ type: "integer" }, "number"],
    [{ type: ["string", "null"] }, "string | null"],
    [{ enum: ["a", "b", 1] }, '"a" | "b" | 1'],
    [{ const: true }, "true"],
    [{ anyOf: [{ type: "string" }, { type: "number" }] }, "string | number"],
    [
      { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] },
      "{ a: string; }",
    ],
    [{ type: "array", items: { type: "string" } }, "string[]"],
    [
      { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
      "Array<string | number>",
    ],
    [{ type: "array", items: [{ type: "string" }, { type: "number" }] }, "[string, number]"],
    [{ type: "object" }, "Record<string, unknown>"],
    [{ type: "object", additionalProperties: false }, "{}"],
    [{ type: "object", additionalProperties: { type: "number" } }, "{ [key: string]: number; }"],
    [{ type: "object", properties: { "a-b": { type: "string" } } }, '{ "a-b"?: string; }'],
    [{ not: {} }, "unknown"],
    ["not a schema", "unknown"],
  ])("writes %j as %s", (schema, expected) => {
    expect(jsonSchemaType(schema)).toBe(expected);
  });

  it("puts each documented property on its own line", () => {
    expect(
      jsonSchemaType({
        type: "object",
        properties: {
          path: { type: "string", description: "Where to read." },
          limit: { type: "number" },
        },
        required: ["path"],
      }),
    ).toBe("{\n  /** Where to read. */\n  path: string;\n  limit?: number;\n}");
  });

  it("follows local refs and stops at a cycle", () => {
    expect(
      jsonSchemaType({
        $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
        $ref: "#/$defs/node",
      }),
    ).toBe("{ next?: unknown; }");
  });

  it("keeps a comment from closing early", () => {
    expect(
      jsonSchemaType({
        type: "object",
        properties: { a: { type: "string", description: "x */ y" } },
      }),
    ).toContain("/** x * / y */");
  });
});

describe("acceptsNothing", () => {
  it("is true unless the schema requires a property", () => {
    expect(acceptsNothing({ type: "object", properties: { a: { type: "string" } } })).toBe(true);
    expect(acceptsNothing({ type: "object", required: ["a"] })).toBe(false);
  });
});
