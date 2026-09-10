// CodemodeRPCTarget is the bootstrap stub a container process talks to
// over /codemode. It adapts a codemode runtime handle to the wire
// contract and, because a rejection would surface on the host rather
// than at the caller, folds every failure into an "error" result.

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

function runtime(execute: CodemodeRuntimeLike["execute"]): CodemodeRuntimeLike {
  return { execute };
}

describe("CodemodeRPCTarget", () => {
  test("describe joins each connector's declarations and lists their names", async () => {
    const target = new CodemodeRPCTarget(
      runtime(async () => completed(1)),
      [connector("kv", "declare const kv: {}"), connector("github", "declare const github: {}")],
    );
    expect(await target.describe()).toEqual({
      types: "declare const kv: {}\ndeclare const github: {}",
      connectors: ["kv", "github"],
    });
  });

  test("describe with no connectors is empty rather than an error", async () => {
    const target = new CodemodeRPCTarget(
      runtime(async () => completed(1)),
      [],
    );
    expect(await target.describe()).toEqual({ types: "", connectors: [] });
  });

  test("execute forwards the code and maps every runtime status", async () => {
    const seen: string[] = [];
    const target = new CodemodeRPCTarget(
      runtime(async ({ code }) => {
        seen.push(code);
        if (code === "pause") return { status: "paused", executionId: "p", pending: [{ seq: 1 }] };
        if (code === "fail")
          return { status: "error", executionId: "e", error: "bad", logs: ["l"] };
        return { status: "completed", executionId: "c", result: 42, logs: ["hi"] };
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
      pending: [{ seq: 1 }],
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
      runtime(async () => {
        throw new Error("boom");
      }),
      [],
    );
    expect(await target.execute({ code: "   " })).toMatchObject({
      status: "error",
      error: "no code provided",
    });
    expect(await target.execute({ code: "x" })).toMatchObject({ status: "error", error: "boom" });
  });
});

function completed(result: unknown): CodemodeRuntimeOutput {
  return { status: "completed", executionId: "id", result };
}
