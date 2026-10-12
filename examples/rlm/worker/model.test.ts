import { beforeEach, describe, expect, it, vi } from "vitest";

import { createModel, type ModelEnv } from "./model";

const { createWorkersAIMock, selectModelMock } = vi.hoisted(() => ({
  createWorkersAIMock: vi.fn<(...args: unknown[]) => unknown>(),
  selectModelMock: vi.fn<(...args: unknown[]) => { specificationVersion: string }>(() => ({
    specificationVersion: "v3",
  })),
}));

vi.mock("workers-ai-provider", () => ({ createWorkersAI: createWorkersAIMock }));

beforeEach(() => {
  createWorkersAIMock.mockReset();
  selectModelMock.mockClear();
  createWorkersAIMock.mockReturnValue(selectModelMock);
});

describe("Workers AI transport selection", () => {
  it("prefers the authenticated AI binding even when REST credentials exist", () => {
    const binding = {} as Ai;
    createModel({
      AI: binding,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    } as ModelEnv);

    expect(createWorkersAIMock).toHaveBeenCalledWith({ binding });
  });

  it("uses REST credentials only when the fallback is explicitly enabled", () => {
    createModel({
      AI: {} as Ai,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      WORKERS_AI_USE_REST: "true",
    } as ModelEnv);

    expect(createWorkersAIMock).toHaveBeenCalledWith({ accountId: "account", apiKey: "token" });
  });
});
