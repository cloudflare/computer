import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

import { transformCell } from "./transform.js";

// Behavior seam: transformed cells run inside an async function with a
// shared `globalThis`; later cells must see earlier cells' top-level
// bindings, and a trailing expression (or explicit return) is the value.
//
// This vm harness is the fast unit layer, not a workerd equivalent: it
// approximates the real path (an ESM module function in a fresh isolate)
// with a strict-mode script against a sandbox global. Full-fidelity
// coverage of the same transform output lives in tests/repl.test.ts,
// which runs cells through real workerd isolates.
async function runCells(cells: string[]): Promise<unknown> {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  let last: unknown;
  for (const cell of cells) {
    // "use strict" matches module-code strictness in the real isolate.
    const code = `(async () => {\n"use strict";\n${transformCell(cell)}\n})()`;
    last = await runInNewContext(code, sandbox);
  }
  return last;
}

describe("transformCell", () => {
  it("returns a trailing expression as the cell value", async () => {
    expect(await runCells(["const a = 2;\na * 3"])).toBe(6);
  });

  it("honors an explicit return; trailing code after it is unreachable", async () => {
    // Standard function semantics: `return` ends the cell, so the trailing
    // expression (still rewritten to a return) never runs.
    expect(await runCells(["const a = 2;\nreturn a + 1;\na * 100"])).toBe(3);
  });

  it("yields undefined when the cell ends in a declaration", async () => {
    expect(await runCells(["const a = 2;"])).toBeUndefined();
  });

  it("persists const/let bindings to later cells", async () => {
    expect(await runCells(["const a = 2; let b = 3;", "b += 1;", "a * b"])).toBe(8);
  });

  it("persists function and class declarations", async () => {
    const value = await runCells([
      "function double(x) { return x * 2; }\nclass Box { constructor(v) { this.v = v; } }",
      "new Box(double(4)).v",
    ]);
    expect(value).toBe(8);
  });

  it("persists destructured bindings, defaults, and rest", async () => {
    const value = await runCells([
      "const { a, b: renamed, c = 30, ...rest } = { a: 1, b: 2, d: 4 };\nconst [x, , y] = [10, 20, 30];",
      "({ a, renamed, c, rest, x, y })",
    ]);
    expect(value).toEqual({ a: 1, renamed: 2, c: 30, rest: { d: 4 }, x: 10, y: 30 });
  });

  it("persists multi-declarator statements and no-init lets", async () => {
    const value = await runCells(["const a = 1, b = 2; let c;", "c = a + b;\nc"]);
    expect(value).toBe(3);
  });

  it("does not persist loop variables", async () => {
    const cell = "let total = 0;\nfor (const n of [1, 2, 3]) total += n;\ntotal";
    expect(await runCells([cell])).toBe(6);
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    await runInNewContext(`(async () => {\n${transformCell(cell)}\n})()`, sandbox);
    expect("n" in sandbox).toBe(false);
  });

  it("supports top-level await", async () => {
    expect(await runCells(["const v = await Promise.resolve(7);", "v"])).toBe(7);
  });

  it("throws a SyntaxError for unparseable code", () => {
    expect(() => transformCell("const = ;")).toThrow(SyntaxError);
  });
});
