import { describe, expect, it } from "vitest";

import { COMPUTER_FINALIZATION_STEP, requiredComputerStep, requiredRlmStep } from "./step-settings";

describe("required Computer steps", () => {
  it("requires the executor throughout bounded exploration", () => {
    expect(requiredComputerStep(0, "system", [])).toEqual({
      toolChoice: { type: "tool", toolName: "executor" },
    });
  });

  it("retries recursive inference when the first execution produced no child evidence", () => {
    expect(requiredRlmStep(1, "system", [], false)).toMatchObject({
      instructions: expect.stringContaining("did not use recursive inference"),
      messages: [{ role: "user", content: expect.stringContaining("codemode:model") }],
      toolChoice: { type: "tool", toolName: "executor" },
    });
  });

  it("finalizes recursion as soon as child evidence exists", () => {
    expect(requiredRlmStep(1, "system", [], true)).toMatchObject({
      instructions: expect.stringContaining("typed { answer }"),
    });
  });

  it("requires a final typed execution on the last step", () => {
    expect(requiredComputerStep(COMPUTER_FINALIZATION_STEP, "system", [])).toMatchObject({
      instructions: expect.stringContaining("typed { answer }"),
      messages: [{ role: "user", content: expect.stringContaining("answer now") }],
      toolChoice: { type: "tool", toolName: "executor" },
    });
  });
});
