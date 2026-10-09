/**
 * pi tools as `ws:tools` bindings, so code running in `exec` can call
 * the same tools the model does.
 *
 *   modules: { "ws:tools": createToolBindings(forPiTools(() => tools, { validate: validateToolArguments })) }
 *
 * A pi `Tool` from `@earendil-works/pi-ai` is only a declaration: the
 * agent loop around it runs it. So this takes either executable tools in
 * the shape `@earendil-works/pi-agent-core` defines, or the declarations
 * and dispatcher `createPiTools` returns.
 */

import type { ToolBinding, ToolBindingResult } from "../../modules/tools.js";
import type { WorkspaceRuntimeValue } from "../../runtime/types.js";
import type { CreatePiToolsResult, PiToolResultContent } from "./index.js";

/**
 * Structurally compatible with `AgentTool` from
 * `@earendil-works/pi-agent-core`, declared locally so pi is not a
 * build-time dependency.
 */
export interface PiAgentTool {
  name: string;
  description: string;
  parameters: object;
  /** Repairs raw arguments before they are validated, as pi's agent loop does. */
  prepareArguments?: (args: unknown) => unknown;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiAgentToolResult>;
}

/** Structurally compatible with `AgentToolResult` from `@earendil-works/pi-agent-core`. */
export interface PiAgentToolResult {
  content: readonly (PiToolResultContent | { type: string })[];
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** The tool call a validator receives, shaped like pi-ai's `ToolCall`. */
export interface PiToolCallRequest {
  type: "toolCall";
  id: string;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: pi-ai's ToolCall types arguments as its own JSON object, which only `any` matches without a dependency on pi-ai.
  arguments: Record<string, any>;
}

/** Options for {@link forPiTools}. */
export interface ForPiToolsOptions<T extends PiAgentTool> {
  /**
   * Checks a call's arguments against the tool's schema and returns the
   * ones to run with. Pass pi-ai's `validateToolArguments` so code is
   * held to the same check as the model. Without it, arguments reach
   * the tool unchecked.
   */
  validate?: (tool: T, call: PiToolCallRequest) => unknown;
}

/**
 * Bindings for {@link createToolBindings} from pi tools.
 *
 * Each call runs the way pi's agent loop runs a model's call:
 * `prepareArguments` first, then `validate`, then `execute` with a fresh
 * call id and the call's abort signal. A failure in any step rejects the
 * call. A result the tool marks `isError` resolves with `isError: true`.
 *
 * @param tools - Executable pi tools, a function returning them, or the
 *   result of `createPiTools`.
 * @param options - The validator to check arguments with.
 * @returns A function returning the bindings, called each time a
 *   backend connects.
 */
export function forPiTools<T extends PiAgentTool>(
  tools: readonly T[] | (() => readonly T[]),
  options?: ForPiToolsOptions<T>,
): () => ToolBinding[];
export function forPiTools(tools: CreatePiToolsResult): () => ToolBinding[];
export function forPiTools<T extends PiAgentTool>(
  tools: readonly T[] | (() => readonly T[]) | CreatePiToolsResult,
  options: ForPiToolsOptions<T> = {},
): () => ToolBinding[] {
  if (typeof tools === "function") return () => tools().map((tool) => agentBinding(tool, options));
  if (Array.isArray(tools)) return () => tools.map((tool) => agentBinding(tool, options));
  const { tools: declarations, execute } = tools as CreatePiToolsResult;
  return () =>
    declarations.map((declaration) => ({
      name: declaration.name,
      async call(input, context) {
        const result = await execute(
          { id: callId(), name: declaration.name, arguments: input },
          { abortSignal: context.signal },
        );
        return bindingResult(result);
      },
    }));
}

function agentBinding<T extends PiAgentTool>(tool: T, options: ForPiToolsOptions<T>): ToolBinding {
  return {
    name: tool.name,
    async call(input, context) {
      const id = callId();
      const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
      const args = options.validate
        ? options.validate(tool, {
            type: "toolCall",
            id,
            name: tool.name,
            arguments: prepared as PiToolCallRequest["arguments"],
          })
        : prepared;
      return bindingResult(await tool.execute(id, args, context.signal));
    },
  };
}

function callId(): string {
  return `ws-tools-${crypto.randomUUID()}`;
}

// Code reads text, so an image is named in place rather than handed
// back as base64 it would have to recognize and skip.
function bindingResult(result: PiAgentToolResult): ToolBindingResult {
  const text = result.content
    .map((part) => {
      if (part.type === "text") return (part as { text: string }).text;
      if (part.type === "image") return `[image: ${(part as { mimeType: string }).mimeType}]`;
      return `[${part.type}]`;
    })
    .join("\n");
  return {
    text,
    // SAFETY: pi tool details and structured content are JSON by pi's own contract; the runtime rejects anything else when it sends the result.
    details: (result.details ?? null) as WorkspaceRuntimeValue,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent as WorkspaceRuntimeValue }),
    isError: result.isError === true,
  };
}
