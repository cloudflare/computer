/**
 * AI SDK tools as `ws:tools` bindings, so code running in `exec` can
 * call the same tools the model does.
 *
 *   modules: { "ws:tools": createToolBindings(forAISDKTools(() => tools)) }
 */

import type { Tool, ToolSet } from "ai";
import type { ToolBinding } from "../../modules/tools.js";
import type { WorkspaceRuntimeValue } from "../../runtime/types.js";
import { toJSONValue } from "./output.js";

/**
 * Bindings for `createToolBindings` from an AI SDK tool set.
 *
 * Tools with no `execute` function run in the browser, and tools that
 * set `needsApproval` wait for a person; neither can run from code, so
 * both are left out. A streaming tool resolves with its last value.
 *
 * Pass a function when the tool set changes, such as an agent's tools
 * for the current turn. The function is read when a backend connects,
 * to list the tools, and again on every call, so a call always runs the
 * tool as it is now.
 *
 * @param tools - The tool set, or a function returning it.
 * @returns A function returning the bindings, called each time a
 *   backend connects.
 */
export function forAISDKTools(tools: ToolSet | (() => ToolSet)): () => ToolBinding[] {
  const current = typeof tools === "function" ? tools : () => tools;
  return () =>
    Object.entries(current())
      .filter(([, tool]) => runsFromCode(tool))
      .map(([name]) => ({
        name,
        async call(input, context) {
          const tool = current()[name];
          if (!tool?.execute || !runsFromCode(tool)) {
            throw new Error(`No tool named ${JSON.stringify(name)} is available.`);
          }
          const output = await lastValue(
            // SAFETY: A tool set erases each tool's input type. The code passed one object of arguments, which is what the model would pass, and the tool checks its own input.
            await tool.execute(input as never, {
              toolCallId: `ws-tools-${crypto.randomUUID()}`,
              messages: [],
              context: {},
              abortSignal: context.signal,
            }),
          );
          return {
            text: typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
            // SAFETY: toJSONValue round-trips the output through JSON, so it holds only values the runtime can send.
            details: toJSONValue(output) as WorkspaceRuntimeValue,
            isError: false,
          };
        },
      }));
}

function runsFromCode(tool: Tool): boolean {
  return typeof tool.execute === "function" && !tool.needsApproval;
}

async function lastValue(output: unknown): Promise<unknown> {
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return output;
  let last: unknown;
  for await (const value of output as AsyncIterable<unknown>) last = value;
  return last;
}
