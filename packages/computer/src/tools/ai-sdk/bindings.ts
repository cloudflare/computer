/**
 * AI SDK tools as `codemode:tools` bindings, so code running in `exec` can
 * call the same tools the model does.
 *
 *   modules: { "codemode:tools": createToolBindings(forAISDKTools(() => tools)) }
 */

import { asSchema, type Tool, type ToolSet } from "ai";
import type { ToolBinding } from "../../modules/tools";
import type { WorkspaceRuntimeValue } from "../../runtime/types";
import { toJSONValue } from "./output";

/**
 * Bindings for `createToolBindings` from an AI SDK tool set.
 *
 * Tools with no `execute` function run in the browser, and tools that
 * set `needsApproval` wait for a person; neither can run from code, so
 * both are left out.
 *
 * A call is checked against the tool's `inputSchema` before it runs, as
 * the AI SDK checks a model's call, and the tool gets the parsed value,
 * so a schema's defaults apply. Arguments that fail the check reject the
 * call. A streaming tool resolves with its last value. A result shaped
 * `{ error: string }`, which is how this package's tools report a
 * failure, resolves with `isError: true` and the message as the text.
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
            // SAFETY: A tool set erases each tool's input type. The value has passed the tool's own schema, when it has one that validates.
            await tool.execute((await parseInput(name, tool, input)) as never, {
              toolCallId: `ws-tools-${crypto.randomUUID()}`,
              messages: [],
              context: {},
              abortSignal: context.signal,
            }),
          );
          const error = errorMessage(output);
          return {
            text: error ?? (typeof output === "string" ? output : (JSON.stringify(output) ?? "")),
            // SAFETY: toJSONValue round-trips the output through JSON, so it holds only values the runtime can send.
            details: toJSONValue(output) as WorkspaceRuntimeValue,
            isError: error !== undefined,
          };
        },
      }));
}

// A schema with no validator, such as `jsonSchema()` without one, lets
// the input through unchanged, as the AI SDK itself does.
async function parseInput(name: string, tool: Tool, input: unknown): Promise<unknown> {
  const validate = asSchema(tool.inputSchema).validate;
  if (validate === undefined) return input;
  const result = await validate(input);
  if (!result.success) throw new Error(`Invalid arguments for ${name}: ${result.error.message}`);
  return result.value;
}

// The failure shape this package's tools return, and the one
// `defaultModelOutput` shows the model as an error.
function errorMessage(output: unknown): string | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const error = (output as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
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
