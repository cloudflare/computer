/**
 * Tools for [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai`).
 *
 * A TanStack tool is a plain object with a `name`, a `description`, an
 * `inputSchema`, and an `execute`. `inputSchema` is a Standard Schema,
 * which Zod v4 implements, so the schemas in `./spec.js` are passed
 * through untouched — no conversion and no second copy of any schema.
 *
 * `createTanStackTools` returns the record shape `chat({ tools })`
 * accepts, keyed by tool name, which is also what `mergeAgentTools`
 * expects for a server-side registry.
 */

import type { z } from "zod";
import { type CreateToolsOptions, createToolSpecs } from "./registry.js";
import {
  applyModelOutput,
  type ModelOutput,
  modelOutputToText,
  runSpec,
  settle,
  type ToolSpecSet,
} from "./spec.js";

/**
 * A TanStack AI server tool.
 *
 * Structurally compatible with the objects `toolDefinition().server()`
 * produces, declared locally so this module does not need `@tanstack/ai`
 * at build time. `chat()` reads exactly these fields for a server tool.
 */
export interface TanStackTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input, context?: TanStackToolExecutionContext) => Promise<unknown>;
  needsApproval?: boolean;
}

/**
 * The execution context TanStack passes to a server tool.
 *
 * Only the fields this adapter uses are declared. `abortSignal` is
 * absent from the context, so cancellation is wired through the
 * `signal` option on `createTanStackTools` instead.
 */
export interface TanStackToolExecutionContext {
  toolCallId?: string;
  emitCustomEvent?: (eventName: string, value: Record<string, unknown>) => void;
}

export type TanStackToolSet = Record<string, TanStackTool<never>>;

export interface CreateTanStackToolsOptions extends CreateToolsOptions {
  /**
   * Tool names that should pause for user approval before running.
   *
   * TanStack surfaces approval as a tool-level flag, so this is the
   * natural place to gate the destructive tools in a UI that wants a
   * confirmation step: `{ approve: ["delete", "exec"] }`.
   */
  approve?: string[];
  /**
   * Signal that cancels in-flight tool executions.
   *
   * TanStack's tool execution context carries no abort signal, so a
   * caller that wants `exec` to stop when the request is aborted passes
   * the same signal it gave `chat({ abortController })` here.
   */
  signal?: AbortSignal;
  /**
   * Emit progressive `exec` snapshots as custom stream events.
   *
   * TanStack tools settle on one return value, so intermediate output
   * is otherwise discarded. When true, each pre-terminal snapshot is
   * forwarded through `emitCustomEvent` under this event name so a UI
   * can show a command's output while it runs. Defaults to false.
   */
  streamEventName?: string;
}

/**
 * Build the TanStack AI tool set for a Workspace.
 *
 * The returned record is keyed by tool name and holds the same tools,
 * caps, and gating as the AI SDK and pi entrypoints.
 */
export function createTanStackTools(options: CreateTanStackToolsOptions): TanStackToolSet {
  const specs = createToolSpecs(options);
  return toTanStackTools(specs, options);
}

/** Adapt an existing spec set to TanStack tools. */
export function toTanStackTools(
  specs: ToolSpecSet,
  options: Omit<CreateTanStackToolsOptions, keyof CreateToolsOptions> = {},
): TanStackToolSet {
  const approve = new Set(options.approve ?? []);
  const tools: TanStackToolSet = {};

  for (const spec of Object.values(specs)) {
    tools[spec.name] = {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      needsApproval: approve.has(spec.name) ? true : undefined,
      execute: async (input, context) => {
        const returned = runSpec(spec, input, { abortSignal: options.signal });
        const output = options.streamEventName
          ? await settleWithEvents(returned, options.streamEventName, context)
          : await settle(returned);
        return toTanStackOutput(await applyModelOutput(spec, input, output));
      },
    } as TanStackTool<never>;
  }

  return tools;
}

/**
 * Drain an executor, forwarding pre-terminal snapshots as custom events.
 *
 * The last snapshot is the settled result and is returned rather than
 * emitted, so a consumer that ignores custom events still sees the
 * complete outcome as the tool's return value.
 */
async function settleWithEvents<Output>(
  returned: Promise<Output> | AsyncIterable<Output>,
  eventName: string,
  context: TanStackToolExecutionContext | undefined,
): Promise<Output> {
  const emit = context?.emitCustomEvent;
  if (!emit || !isAsyncIterable<Output>(returned)) return settle(returned);

  let last: Output | undefined;
  let seen = false;
  for await (const chunk of returned) {
    if (seen) {
      emit(eventName, { toolCallId: context?.toolCallId, snapshot: last as never });
    }
    last = chunk;
    seen = true;
  }
  if (!seen) throw new Error("tool executor yielded no result");
  return last as Output;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

/**
 * Lower a neutral `ModelOutput` onto a TanStack tool return value.
 *
 * TanStack serializes whatever a tool returns into the tool-result
 * message, so structured results stay objects. Media has no typed
 * tool-result part, so an image or PDF returns its descriptive text
 * alongside the base64 payload and its media type, letting a caller
 * that cares reattach it as a message part.
 */
function toTanStackOutput(output: ModelOutput): unknown {
  switch (output.type) {
    case "text":
      return output.value;
    case "error-text":
      return { error: output.value };
    case "json":
      return output.value;
    case "media":
      return {
        text: output.text,
        mediaType: output.mediaType,
        filename: output.filename,
        data: output.data,
      };
  }
}

export { modelOutputToText };
