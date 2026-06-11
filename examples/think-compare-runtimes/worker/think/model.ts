import { createWorkersAI } from "workers-ai-provider";

const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

export function createRuntimeThinkModel(binding: Ai) {
  return createWorkersAI({ binding })(MODEL_ID, { reasoning_effort: "low" });
}
