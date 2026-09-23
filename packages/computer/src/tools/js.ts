// AI SDK shim for the `js` tool. The tool itself is framework-agnostic —
// `createJsToolDefinition` in src/repl/tool.ts carries the description,
// JSON Schema, and executor with zero framework dependencies. This file is
// the few lines that dress it as an AI SDK tool; a pi or MCP wrapper is
// the same pattern around `run()` (see renderJsResultText for text-only
// frameworks).

import { jsonSchema, type Tool, tool } from "ai";

import {
  createJsToolDefinition,
  type JsToolInput,
  type JsToolOptions,
} from "../repl/tool.js";
import type { ReplExecutionResult } from "../repl/types.js";

export type { JsToolInput, JsToolOptions };

export function createJsTool(options: JsToolOptions): Tool<JsToolInput, ReplExecutionResult> {
  const definition = createJsToolDefinition(options);
  return tool({
    description: definition.description,
    inputSchema: jsonSchema<JsToolInput>(definition.inputSchema),
    execute: (input, { abortSignal }) => definition.run(input, { signal: abortSignal }),
  });
}
