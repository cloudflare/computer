// CodemodeRPCTarget is the bootstrap stub a container process talks to
// over /codemode. It adapts a codemode runtime handle to the wire
// contract and, because a rejection would surface on the host rather
// than at the caller, folds every run failure into an "error" result.
// Approval is deliberately absent from the surface.

import { describe, expect, test } from "vitest";

import {
  type CodemodeConnectorLike,
  CodemodeRPCTarget,
  type CodemodeRuntimeLike,
  type CodemodeRuntimeOutput,
} from "./codemode-session.js";

function connector(name: string, types: string): CodemodeConnectorLike {
  return { name: () => name, getTypeScriptTypes: async () => types };
}

const pendingAction = { executionId: "p", seq: 1, connector: "kv", method: "put", args: {} };

function runtime(overrides: Partial<CodemodeRuntimeLike> = {}): CodemodeRuntimeLike {
  return {
    execute: async () => completed(1),
    search: async (query) => ({
      results: [{ path: `kv.${query}`, connector: "kv", method: query, kind: "method", score: 1 }],
      total: 1,
      truncated: false,
    }),
    describe: async (target) => ({
      path: target,
      types: `declare const ${target}: {}`,
      kind: "connector",
    }),
    pending: async () => [pendingAction],
    ...overrides,
  };
}

describe("CodemodeRPCTarget", () => {
  test("types joins each connector's declarations and lists their names", async () => {
    const target = new CodemodeRPCTarget(runtime(), [
      connector("kv", "declare const kv: {}"),
      connector("github", "declare const github: {}"),
    ]);
    expect(await target.types()).toEqual({
      types: "declare const kv: {}\ndeclare const github: {}",
      connectors: ["kv", "github"],
    });
  });

  test("types with no connectors is empty rather than an error", async () => {
    expect(await new CodemodeRPCTarget(runtime(), []).types()).toEqual({
      types: "",
      connectors: [],
    });
  });

  test("search, describe, and pending pass straight through to the runtime", async () => {
    const target = new CodemodeRPCTarget(runtime(), []);
    expect((await target.search("get")).results[0]?.path).toBe("kv.get");
    expect((await target.describe("kv")).types).toBe("declare const kv: {}");
    expect(await target.pending("p")).toEqual([pendingAction]);
  });

  test("execute forwards the code and maps every runtime status", async () => {
    const seen: string[] = [];
    const target = new CodemodeRPCTarget(
      runtime({
        execute: async ({ code }) => {
          seen.push(code);
          if (code === "pause")
            return { status: "paused", executionId: "p", pending: [pendingAction] };
          if (code === "fail")
            return { status: "error", executionId: "e", error: "bad", logs: ["l"] };
          return { status: "completed", executionId: "c", result: 42, logs: ["hi"] };
        },
      }),
      [],
    );
    expect(await target.execute({ code: "return 42" })).toEqual({
      status: "completed",
      executionId: "c",
      result: 42,
      logs: ["hi"],
    });
    expect(seen).toEqual(["return 42"]);
    expect(await target.execute({ code: "pause" })).toEqual({
      status: "paused",
      executionId: "p",
      pending: [pendingAction],
    });
    expect(await target.execute({ code: "fail" })).toEqual({
      status: "error",
      executionId: "e",
      error: "bad",
      logs: ["l"],
    });
  });

  test("execute never rejects: empty code and a throwing runtime become error results", async () => {
    const target = new CodemodeRPCTarget(
      runtime({
        execute: async () => {
          throw new Error("boom");
        },
      }),
      [],
    );
    expect(await target.execute({ code: "   " })).toMatchObject({
      status: "error",
      error: "no code provided",
    });
    expect(await target.execute({ code: "x" })).toMatchObject({ status: "error", error: "boom" });
  });

  test("the surface has no way to approve or reject", () => {
    const target = new CodemodeRPCTarget(runtime(), []) as unknown as Record<string, unknown>;
    expect(target.approve).toBeUndefined();
    expect(target.reject).toBeUndefined();
    expect(target.rollback).toBeUndefined();
  });
});

function completed(result: unknown): CodemodeRuntimeOutput {
  return { status: "completed", executionId: "id", result };
}
