import { beforeEach, describe, expect, test, vi } from "vitest";
import { createRuntimeThinkModel } from "./model";

const createWorkersAI = vi.hoisted(() => vi.fn());
const modelFactory = vi.hoisted(() => vi.fn());

vi.mock("workers-ai-provider", () => ({
  createWorkersAI,
}));

describe("createRuntimeThinkModel", () => {
  beforeEach(() => {
    createWorkersAI.mockReset();
    modelFactory.mockReset();
    createWorkersAI.mockReturnValue(modelFactory);
  });

  test("uses low Kimi reasoning", () => {
    const binding = {} as Ai;

    createRuntimeThinkModel(binding);

    expect(createWorkersAI).toHaveBeenCalledWith({ binding });
    expect(modelFactory).toHaveBeenCalledWith("@cf/moonshotai/kimi-k2.6", {
      reasoning_effort: "low",
    });
  });
});
