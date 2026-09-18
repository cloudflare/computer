/**
 * SDK-neutral tool specifications.
 *
 * A `ToolSpec` is the single description of one workspace tool: its
 * model-facing name and description, its Zod input schema, its executor,
 * and an optional hook that shapes the value the model finally sees.
 * Nothing in this module imports an agent SDK.
 *
 * Each SDK entrypoint (`./ai.js`, `./pi.js`, `./tanstack.js`) is a thin
 * adapter over the same specs, so a behavior change to a tool lands in
 * one place and reaches every SDK. `./registry.js` builds the spec set;
 * the adapters only translate the shape.
 */

import type { z } from "zod";

/**
 * How a result should be presented to the model.
 *
 * The file tools return rich structured results, but the best prompt
 * representation is not always JSON: a complete text read is cheaper as
 * plain text, an error reads better as an error string, and an image or
 * PDF has to travel as a typed media part. `ModelOutput` names those
 * cases in SDK-neutral terms and each adapter lowers them onto whatever
 * its SDK supports, degrading to text when the SDK has no equivalent.
 */
export type ModelOutput =
  | { type: "text"; value: string }
  | { type: "error-text"; value: string }
  | { type: "json"; value: unknown }
  /**
   * An image or PDF to hand the model.
   *
   * `data` is base64 because that is how the read tool captures the
   * bytes and how pi and TanStack want them on the wire. The AI SDK
   * accepts a base64 string for a `file` part too, so no adapter has to
   * decode it.
   */
  | { type: "media"; text: string; data: string; mediaType: string; filename?: string };

/**
 * One tool, described once, independent of any SDK.
 *
 * `execute` may return a value or an async iterable of progressive
 * snapshots. Streaming tools (`exec`) yield successive snapshots of the
 * same run; adapters for SDKs without streaming tool results drain the
 * iterable and keep the final snapshot, which is why every yielded value
 * is a complete, self-contained result rather than a delta.
 */
export interface ToolSpec<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  /**
   * Shape of a successful result.
   *
   * Optional and never used to gate execution: an executor returns
   * either this shape or `{ error }`, and the error branch is a normal
   * outcome rather than a validation failure. Adapters forward it to
   * SDKs that can describe a tool's output to the model or type a
   * client-side handler.
   */
  outputSchema?: z.ZodType;
  execute: (input: Input, context: ToolCallContext) => Promise<Output> | AsyncIterable<Output>;
  /**
   * Map a settled result onto its model-facing representation. Omit to
   * let the adapter apply its SDK's default encoding of the raw value.
   */
  toModelOutput?: (args: { input: Input; output: Output }) => ModelOutput | Promise<ModelOutput>;
  /** SDK-agnostic traits adapters lower onto native features. */
  traits?: ToolTraits;
}

/**
 * Properties of a tool that some SDKs can act on natively.
 *
 * These describe the tool itself rather than any one SDK's encoding of
 * it, so the shared registry can state them once and each adapter can
 * use them where its SDK has a matching feature and ignore them where
 * it does not.
 */
export interface ToolTraits {
  /**
   * The tool changes workspace state.
   *
   * Drives approval gating in SDKs that support it, so a caller asking
   * to confirm destructive work does not have to restate which tools
   * those are.
   */
  mutates?: boolean;
  /**
   * The tool's arguments are worth constraining during sampling.
   *
   * Set for tools whose arguments are structurally fussy enough that a
   * malformed call costs a wasted turn — long verbatim strings, nested
   * arrays. pi maps it to provider-side strict schema enforcement.
   */
  strictArguments?: boolean;
  /**
   * The tool emits progressive snapshots while it runs.
   *
   * Lets an adapter decide whether to wire streaming machinery at all,
   * rather than inspecting the executor's return value at call time.
   */
  streams?: boolean;
}

/**
 * Per-call information an executor may use.
 *
 * Only cancellation is portable across the three SDKs today, so that is
 * all this carries. Keeping it an object rather than a bare signal lets
 * later additions stay backward compatible.
 */
export interface ToolCallContext {
  abortSignal?: AbortSignal;
}

/**
 * A tool spec whose input type has been erased.
 *
 * A spec set holds tools with different input types, so the element
 * type has to forget them. Erasing to `ToolSpec<unknown>` would be
 * unsound in `execute`'s contravariant parameter and erasing to
 * `ToolSpec<never>` makes the set unusable, so the schema and the
 * executor are restated as an internally-consistent pair: whatever the
 * schema parses is exactly what the executor accepts, even though a
 * caller can no longer name that type.
 */
export interface AnyToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
  execute: (input: never, context: ToolCallContext) => Promise<unknown> | AsyncIterable<unknown>;
  toModelOutput?: (args: { input: never; output: never }) => ModelOutput | Promise<ModelOutput>;
  traits?: ToolTraits;
}

/** A spec set keyed by model-facing tool name. */
export type ToolSpecSet = Record<string, AnyToolSpec>;

/**
 * Run an erased spec.
 *
 * The cast is the one place the erasure is reintroduced. It is sound
 * because `AnyToolSpec` guarantees the schema and executor came from the
 * same `ToolSpec`, so a value the schema produced is a value the
 * executor accepts.
 */
export function runSpec(
  spec: AnyToolSpec,
  input: unknown,
  context: ToolCallContext,
): Promise<unknown> | AsyncIterable<unknown> {
  return (
    spec.execute as (i: unknown, c: ToolCallContext) => Promise<unknown> | AsyncIterable<unknown>
  )(input, context);
}

/** Apply an erased spec's model-output hook, if it has one. */
export async function applyModelOutput(
  spec: AnyToolSpec,
  input: unknown,
  output: unknown,
): Promise<ModelOutput> {
  if (!spec.toModelOutput) return defaultModelOutput(output);
  const hook = spec.toModelOutput as (args: {
    input: unknown;
    output: unknown;
  }) => ModelOutput | Promise<ModelOutput>;
  return await hook({ input, output });
}

/**
 * Declare a spec while keeping `Input` and `Output` inferred.
 *
 * Without this helper every spec would need its generics written out to
 * keep `execute` and `toModelOutput` agreeing on one input type.
 */
export function defineTool<Input, Output>(spec: ToolSpec<Input, Output>): ToolSpec<Input, Output> {
  return spec;
}

/**
 * Drain an executor to its settled result.
 *
 * Shared by the adapters whose SDKs cannot forward progressive tool
 * output. The last yielded snapshot is the terminal one; an iterable
 * that yields nothing is a contract violation by the executor.
 */
export async function settle<Output>(
  returned: Promise<Output> | AsyncIterable<Output>,
): Promise<Output> {
  if (isAsyncIterable(returned)) {
    let last: Output | undefined;
    let seen = false;
    for await (const chunk of returned) {
      last = chunk;
      seen = true;
    }
    if (!seen) throw new Error("tool executor yielded no result");
    return last as Output;
  }
  return await returned;
}

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

/**
 * Default model representation for a spec without a `toModelOutput`.
 *
 * An `{ error }` result becomes error text so SDKs that distinguish tool
 * failures can mark the call as failed; everything else stays JSON.
 */
export function defaultModelOutput(output: unknown): ModelOutput {
  if (
    typeof output === "object" &&
    output !== null &&
    typeof (output as { error?: unknown }).error === "string"
  ) {
    return { type: "error-text", value: (output as { error: string }).error };
  }
  return { type: "json", value: output };
}

/** Render a `ModelOutput` as plain text, for SDKs with no richer channel. */
export function modelOutputToText(output: ModelOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "media":
      return output.text;
  }
}
