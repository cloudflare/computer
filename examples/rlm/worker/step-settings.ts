import type { ModelMessage } from "ai";

export const COMPUTER_FINALIZATION_STEP = 1;

const FINALIZATION_INSTRUCTION =
  'Return the benchmark answer now. The next executor module must return a typed { answer } object using evidence already seen. Do not inspect more data, return diagnostics, or call ws:model again. The final module must contain no imports or file I/O. Use exactly this shape: export default async function () { return { answer: "derived answer" }; }';
const RECURSION_RETRY_INSTRUCTION =
  "The previous execution did not use recursive inference. Call batch(requests) from ws:model now with question-specific requests over the Workspace chunks, then return the child findings.";

export function requiredComputerStep(
  stepNumber: number,
  instructions: string,
  messages: ModelMessage[],
) {
  if (stepNumber < COMPUTER_FINALIZATION_STEP) return { toolChoice: executorChoice() };
  return finalStep(instructions, messages);
}

export function requiredRlmStep(
  stepNumber: number,
  instructions: string,
  messages: ModelMessage[],
  hasChildEvidence: boolean,
) {
  if (stepNumber === 0) return { toolChoice: executorChoice() };
  if (!hasChildEvidence && stepNumber < 2) {
    return {
      toolChoice: executorChoice(),
      instructions: `${instructions}\n\n${RECURSION_RETRY_INSTRUCTION}`,
      messages: [...messages, { role: "user" as const, content: RECURSION_RETRY_INSTRUCTION }],
    };
  }
  return finalStep(instructions, messages);
}

function finalStep(instructions: string, messages: ModelMessage[]) {
  return {
    toolChoice: executorChoice(),
    instructions: `${instructions}\n\n${FINALIZATION_INSTRUCTION}`,
    messages: [...messages, { role: "user" as const, content: FINALIZATION_INSTRUCTION }],
  };
}

function executorChoice() {
  return { type: "tool" as const, toolName: "executor" as const };
}
