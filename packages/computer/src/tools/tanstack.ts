/**
 * Tools for [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai`).
 *
 * A TanStack tool is a plain object with a `name`, a `description`, an
 * `inputSchema`, and an `execute`. `inputSchema` is a Standard Schema,
 * which Zod v4 implements, so the schemas in `./spec.js` are passed
 * through untouched — no conversion and no second copy of any schema.
 *
 * `createTanStackTools` returns the tools keyed by name, which is the
 * shape a server-side registry and `mergeAgentTools` expect. `chat()`
 * itself takes a list, so pass `Object.values(tools)` there.
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
  /**
   * Shape of a successful result. TanStack validates a tool return
   * against it client-side and threads it into the typed hooks, so a UI
   * gets the result shape without restating it.
   */
  outputSchema?: z.ZodType;
  // TanStack hands the validated arguments back as `any`, so the
  // parameter is declared the same way here. A narrower parameter would
  // be unsound in the position TanStack calls it from, and each spec
  // validates its own input before using it.
  // biome-ignore lint/suspicious/noExplicitAny: matches the signature chat() calls
  execute: (input: any, context?: TanStackToolExecutionContext) => Promise<unknown>;
  needsApproval?: boolean;
  /**
   * Withheld from the prompt until discovered through TanStack lazy
   * tool discovery, which keeps a large tool set out of the system
   * prompt until it is wanted.
   */
  lazy?: boolean;
  /**
   * Phantom marker TanStack uses to tell an ordinary tool apart from a
   * provider-supplied one. It carries no value at runtime; declaring it
   * `undefined` is what lets a tool built here satisfy the union
   * `chat({ tools })` accepts.
   */
  readonly "~toolKind"?: undefined;
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

/**
 * A tool set keyed by name.
 *
 * The element type erases its input to `unknown` rather than `never`:
 * `chat()` accepts a tool whose `execute` takes `any`, and a spec
 * validates its own input before use, so the looser parameter is
 * accurate here and lets the set be spread straight into `chat()`.
 */
export type TanStackToolSet = Record<string, TanStackTool<never>>;

export interface CreateTanStackToolsOptions extends CreateToolsOptions {
  /**
   * Which tools pause for user approval before running.
   *
   * A name list gates exactly those tools. `"mutating"` gates every
   * tool that changes workspace state, which is the common case for a
   * UI that wants a confirmation step and avoids restating the list
   * when the tool set grows.
   */
  approve?: string[] | "mutating";
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
  /**
   * Tools to withhold from the prompt until TanStack lazy discovery
   * asks for them. `"all"` marks the whole set lazy, which suits an
   * agent whose workspace work is occasional rather than central.
   */
  lazy?: string[] | "all";
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
  const tools: TanStackToolSet = {};

  for (const spec of Object.values(specs)) {
    const needsApproval = wants(options.approve, spec.name, spec.traits?.mutates === true);
    const lazy = wants(options.lazy, spec.name, options.lazy === "all");
    tools[spec.name] = {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // Only a successful result is described. The error branch is a
      // normal outcome, so validating every return against the success
      // shape would reject legitimate error results.
      outputSchema: spec.outputSchema,
      needsApproval: needsApproval ? true : undefined,
      lazy: lazy ? true : undefined,
      execute: async (input, context) => {
        const returned = runSpec(spec, input, { abortSignal: options.signal });
        const output =
          options.streamEventName && spec.traits?.streams === true
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

/**
 * Resolve a name-list-or-keyword option for one tool.
 *
 * A list names tools explicitly; a keyword defers to the trait the
 * caller asked to select on.
 */
function wants(option: string[] | string | undefined, name: string, byTrait: boolean): boolean {
  if (option === undefined) return false;
  if (Array.isArray(option)) return option.includes(name);
  return byTrait;
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
