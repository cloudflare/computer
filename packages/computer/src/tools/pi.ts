/**
 * Tools for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`).
 *
 * pi splits a tool in two. `Tool` is pure data — a name, a description,
 * and a TypeBox `parameters` schema — that travels in `Context.tools`,
 * while execution stays with the caller's own agent loop. So this module
 * exposes both halves and keeps them consistent:
 *
 * - `createPiTools` returns the declarations to put in the context.
 * - `createPiToolExecutor` returns a dispatcher that validates a tool
 *   call and runs the matching workspace tool, handing back pi's
 *   `toolResult` content blocks.
 *
 * TypeBox schemas are plain JSON Schema, and pi validates against them
 * with TypeBox's validator, so the Zod schemas in `./spec.js` are
 * converted rather than rewritten. That keeps one schema per tool across
 * all three SDK entrypoints.
 */

import { z } from "zod";
import { type CreateToolsOptions, createToolSpecs } from "./registry.js";
import {
  applyModelOutput,
  type ModelOutput,
  runSpec,
  settle,
  type ToolCallContext,
  type ToolSpecSet,
} from "./spec.js";

/**
 * A pi tool declaration.
 *
 * Structurally compatible with `Tool` from `@earendil-works/pi-ai`, but
 * declared locally so this module does not need pi at build time. pi
 * only reads `name`, `description`, and `parameters`.
 */
export interface PiTool {
  name: string;
  description: string;
  parameters: PiJSONSchema;
}

/** The JSON Schema subset TypeBox and pi exchange for tool parameters. */
export interface PiJSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** One tool call as pi reports it on a `toolcall_end` event. */
export interface PiToolCall {
  id: string;
  name: string;
  arguments?: unknown;
}

/** Content blocks pi accepts on a `toolResult` message. */
export type PiToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * A settled tool result in pi's shape, minus the routing fields.
 *
 * The caller owns `toolCallId`, `toolName`, and `timestamp` because it
 * owns the transcript; this module supplies only what running the tool
 * determined.
 */
export interface PiToolResult {
  content: PiToolResultContent[];
  isError: boolean;
}

export interface CreatePiToolsResult {
  /** Declarations for `Context.tools`. */
  tools: PiTool[];
  /** Run one tool call and get back pi `toolResult` content. */
  execute: (call: PiToolCall, context?: ToolCallContext) => Promise<PiToolResult>;
}

/**
 * Build pi tool declarations and their executor for a Workspace.
 *
 * Returns both halves together so the declarations and the dispatcher
 * cannot drift apart. Callers that only need the declarations can
 * destructure `tools` and ignore `execute`.
 */
export function createPiTools(options: CreateToolsOptions): CreatePiToolsResult {
  const specs = createToolSpecs(options);
  return {
    tools: piToolDeclarations(specs),
    execute: createSpecExecutor(specs),
  };
}

/**
 * Declarations only, for a caller that already has a spec set.
 *
 * Useful when the same specs back both a declaration list sent to the
 * model and a separately-held dispatcher.
 */
export function piToolDeclarations(specs: ToolSpecSet): PiTool[] {
  return Object.values(specs).map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: toPiParameters(spec.inputSchema),
  }));
}

/**
 * Build a dispatcher over a spec set.
 *
 * Arguments are validated against the tool's own Zod schema before the
 * executor runs. pi's loop may also validate with `validateToolCall`;
 * validating here as well means a caller that skips that step still
 * cannot reach an executor with malformed input, and a validation
 * failure comes back as an error result the model can retry against
 * rather than a thrown exception that breaks the loop.
 */
export function createSpecExecutor(
  specs: ToolSpecSet,
): (call: PiToolCall, context?: ToolCallContext) => Promise<PiToolResult> {
  return async (call, context = {}) => {
    const spec = specs[call.name];
    if (!spec) {
      return errorResult(
        `Unknown tool ${JSON.stringify(call.name)}. Available tools: ${Object.keys(specs)
          .map((name) => JSON.stringify(name))
          .join(", ")}.`,
      );
    }

    const parsed = spec.inputSchema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${call.name}: ${formatZodError(parsed.error)}`);
    }

    let output: unknown;
    try {
      output = await settle(runSpec(spec, parsed.data, context));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    return toPiResult(await applyModelOutput(spec, parsed.data, output));
  };
}

/** Lower a neutral `ModelOutput` onto pi's tool-result content blocks. */
function toPiResult(output: ModelOutput): PiToolResult {
  switch (output.type) {
    case "text":
      return { content: [{ type: "text", text: output.value }], isError: false };
    case "error-text":
      return { content: [{ type: "text", text: output.value }], isError: true };
    case "json":
      return {
        content: [{ type: "text", text: stringify(output.value) }],
        isError: false,
      };
    case "media": {
      // pi carries images as base64 blocks on a tool result. Anything
      // else that reached a media output (a PDF) has no tool-result
      // representation, so it degrades to its descriptive text rather
      // than being dropped silently.
      if (!output.mediaType.startsWith("image/")) {
        return {
          content: [
            {
              type: "text",
              text: `${output.text} This file type cannot be attached to a tool result; read it with a dedicated tool if its contents are needed.`,
            },
          ],
          isError: false,
        };
      }
      return {
        content: [
          { type: "text", text: output.text },
          { type: "image", data: output.data, mimeType: output.mediaType },
        ],
        isError: false,
      };
    }
  }
}

/**
 * Convert a Zod schema to the JSON Schema pi hands to TypeBox.
 *
 * `io: "input"` is what makes a field carrying a Zod `.default()`
 * optional in the emitted schema: the default is recorded as a JSON
 * Schema `default` that TypeBox applies during conversion, so the model
 * may omit it. Emitting the output view instead would mark those fields
 * required and force the model to restate values it should not have to.
 */
function toPiParameters(schema: z.ZodType): PiJSONSchema {
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    // Tool parameters are consumed by providers that reject `$ref`
    // pointers into a definitions section, so inline every subschema.
    // The one recursive schema here (`exec`'s structured `input`) would
    // otherwise need a ref, and is reported rather than silently
    // emitted as something the provider will reject.
    reused: "inline",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") {
    throw new Error(`pi tool parameters must be an object schema, got ${String(json.type)}`);
  }
  return json as PiJSONSchema;
}

function errorResult(message: string): PiToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function stringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
