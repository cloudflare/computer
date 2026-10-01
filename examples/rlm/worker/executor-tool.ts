import { createExecTool, type ExecToolOutput } from "@cloudflare/computer/tools";
import type { ToolSet } from "ai";

export const EXECUTOR_BACKEND = "oolong-javascript";
export const RLM_BACKEND = "oolong-rlm-javascript";

type ExecWorkspace = Parameters<typeof createExecTool>[0]["workspace"];
const MAX_SAFE_RESULT_BYTES = 16 * 1024;

export function createExecutorTool(
  workspace: ExecWorkspace,
  backend: typeof EXECUTOR_BACKEND | typeof RLM_BACKEND,
): ToolSet {
  const executor = createExecTool({
    workspace,
    backends: {
      [backend]: {
        description:
          "Callable isolated JavaScript. The command must be a complete ES module with a default async function.",
      },
    },
    maxBytes: 16 * 1024,
    streamMaxBytes: 16 * 1024,
  });
  const execute = executor.execute;
  if (!execute) throw new Error("The executor tool must define execute().");

  return {
    executor: {
      ...executor,
      execute: async function* (...args: Parameters<typeof execute>) {
        const output = await execute(...args);
        if (isAsyncIterable(output)) {
          for await (const snapshot of output) yield sanitizeExecutorOutput(snapshot);
          return;
        }
        yield sanitizeExecutorOutput(output);
      },
    },
  };
}

export function sanitizeExecutorOutput(output: ExecToolOutput): ExecToolOutput {
  const base = { command: output.command, cwd: output.cwd, backend: output.backend };
  if ("error" in output) return { ...base, error: "Generated execution failed." };

  return {
    ...base,
    exitCode: output.exitCode,
    stdout: "",
    stderr: "",
    result: safeResult(output.result),
  };
}

function safeResult(value: unknown): Record<string, unknown> {
  const answer = isRecord(value) && Object.hasOwn(value, "answer") ? value.answer : value;
  const valid =
    typeof answer === "string" ||
    (typeof answer === "number" && Number.isFinite(answer)) ||
    (Array.isArray(answer) &&
      answer.every(
        (item): item is string | number =>
          typeof item === "string" || (typeof item === "number" && Number.isFinite(item)),
      ));

  if (valid && encodedBytes(answer) <= MAX_SAFE_RESULT_BYTES) return { answer };

  return {
    accepted: false,
    reason: "Expected a bounded scalar/list or an object containing answer.",
    received: describeResult(value),
  };
}

function describeResult(value: unknown): string {
  if (Array.isArray(value)) return `array with ${value.length} items`;
  if (isRecord(value)) {
    return Object.hasOwn(value, "answer") ? "object with answer" : "object without answer";
  }
  if (value === null) return "null";
  return typeof value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ExecToolOutput> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

export function extractExecutionResult(toolResults: unknown): {
  found: boolean;
  value: unknown;
  bytes: number;
} {
  if (!Array.isArray(toolResults)) return { found: false, value: undefined, bytes: 0 };
  for (const item of toolResults) {
    if (!isRecord(item) || item.toolName !== "executor" || !isRecord(item.output)) continue;
    if (Object.hasOwn(item.output, "result")) {
      const value = item.output.result;
      return { found: true, value, bytes: encodedBytes(value) };
    }
  }
  return { found: false, value: undefined, bytes: 0 };
}

export function extractGeneratedSourceBytes(toolCalls: unknown): number {
  if (!Array.isArray(toolCalls)) return 0;
  return toolCalls.reduce((total, item) => {
    if (!isRecord(item) || item.toolName !== "executor" || !isRecord(item.input)) return total;
    return total + (typeof item.input.command === "string" ? encodedBytes(item.input.command) : 0);
  }, 0);
}

function encodedBytes(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text ?? "").byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
