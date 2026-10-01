/**
 * pi keeps tool declarations and tool execution apart: declarations
 * travel in `Context.tools` while the caller's own agent loop runs the
 * tools. So this module returns both halves together.
 */

import { z } from "zod";
import { defineExec } from "../common/exec.js";
import { deleteDescription, deleteFromStore, deleteInputSchema } from "../common/fs/delete.js";
import { editDescription, editInputSchema, editInStore } from "../common/fs/edit.js";
import { findDescription, findInputSchema, findInWorkspace } from "../common/fs/find.js";
import { grepDescription, grepInputSchema, grepInWorkspace } from "../common/fs/grep.js";
import { listDescription, listInputSchema, listWorkspace } from "../common/fs/list.js";
import {
  createReadExecutor,
  type ReadInput,
  type ReadToolResult,
  readDescription,
  readInputSchema,
  readModelOutput,
} from "../common/fs/read.js";
import { writeDescription, writeInputSchema, writeToStore } from "../common/fs/write.js";
import { defaultModelOutput, type ModelOutput } from "../common/model-output.js";
import { type CreateToolsOptions, resolveToolOptions } from "../common/options.js";
import {
  createPublishExecutor,
  type PublishWorkspaceLike,
  publishDescription,
  publishInputSchema,
} from "../common/publish.js";
import { settle } from "../common/stream.js";

export interface ToolCallContext {
  abortSignal?: AbortSignal;
}

interface PiToolEntry {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  strictArguments?: boolean;
  execute: (input: never, context: ToolCallContext) => Promise<unknown> | AsyncIterable<unknown>;
  toModelOutput?: (args: { input: never; output: never }) => ModelOutput;
}

/** Structurally compatible with `Tool` from `@earendil-works/pi-ai`, declared locally so pi is not a build-time dependency. */
export interface PiTool {
  name: string;
  description: string;
  parameters: PiJSONSchema;
  constrainedSampling?: { type: "json_schema"; strict: "prefer" | "require" };
}

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

export type PiToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** A tool result minus the routing fields (`toolCallId`, `toolName`, `timestamp`), which the caller owns. */
export interface PiToolResult {
  content: PiToolResultContent[];
  isError: boolean;
}

export interface CreatePiToolsResult {
  tools: PiTool[];
  execute: (call: PiToolCall, context?: ToolCallContext) => Promise<PiToolResult>;
}

export function createPiTools(options: CreatePiToolsOptions): CreatePiToolsResult {
  const entries = piToolEntries(options);
  return {
    tools: declarations(entries, options),
    execute: dispatcher(entries),
  };
}

export interface CreatePiToolsOptions extends CreateToolsOptions, PiDeclarationOptions {}

function piToolEntries(options: CreateToolsOptions): PiToolEntry[] {
  const resolved = resolveToolOptions(options);
  const workspace = resolved.workspace;
  const readExecutor = createReadExecutor(resolved.read);
  const toReadOutput = readModelOutput(resolved.read);

  const entries: PiToolEntry[] = [
    {
      name: "read",
      description: readDescription(resolved.read),
      inputSchema: readInputSchema,
      // Byte offsets must be echoed back verbatim on the next call.
      strictArguments: true,
      execute: (input: ReadInput) => readExecutor(input),
      toModelOutput: ({ input, output }: { input: ReadInput; output: ReadToolResult }) =>
        toReadOutput({ input, output }),
    } as PiToolEntry,
    {
      name: "ls",
      description: listDescription,
      inputSchema: listInputSchema,
      execute: (input) => listWorkspace(workspace, input),
    } as PiToolEntry,
    {
      name: "find",
      description: findDescription,
      inputSchema: findInputSchema,
      execute: (input) => findInWorkspace(workspace, input),
    } as PiToolEntry,
    {
      name: "grep",
      description: grepDescription,
      inputSchema: grepInputSchema,
      execute: (input) => grepInWorkspace(workspace, input),
    } as PiToolEntry,
  ];

  if (resolved.readonly) return entries;

  entries.push(
    {
      name: "write",
      description: writeDescription,
      inputSchema: writeInputSchema,
      // The whole file body travels as one string argument.
      strictArguments: true,
      execute: (input) => writeToStore(resolved.write, input),
    } as PiToolEntry,
    {
      name: "edit",
      description: editDescription,
      inputSchema: editInputSchema,
      // A nested array of exact-match strings is easy to malform.
      strictArguments: true,
      execute: (input) => editInStore(resolved.edit, input),
    } as PiToolEntry,
    {
      name: "delete",
      description: deleteDescription,
      inputSchema: deleteInputSchema,
      execute: (input) => deleteFromStore(resolved.delete, input),
    } as PiToolEntry,
  );

  if (resolved.exec !== undefined) {
    const exec = defineExec(resolved.exec);
    entries.push({
      name: "exec",
      description: exec.description,
      inputSchema: exec.inputSchema,
      execute: (input, context) => exec.execute(input, context),
    } as PiToolEntry);
  }

  if (resolved.publish) {
    const executor = createPublishExecutor(workspace as PublishWorkspaceLike);
    entries.push({
      name: "publish",
      description: publishDescription,
      inputSchema: publishInputSchema,
      execute: (input) => executor(input),
    } as PiToolEntry);
  }

  return entries;
}

// The schemas stay open. pi closes a schema itself when it sends a
// `constrainedSampling` tool in strict mode, and keeps the open one for
// a provider that falls back to ordinary tool calling.
function declarations(entries: readonly PiToolEntry[], options: PiDeclarationOptions): PiTool[] {
  const strict = options.constrainedSampling ?? "prefer";
  return entries.map((entry) => {
    const tool: PiTool = {
      name: entry.name,
      description: entry.description,
      parameters: toPiParameters(entry.inputSchema),
    };
    if (strict !== false && entry.strictArguments === true) {
      tool.constrainedSampling = { type: "json_schema", strict };
    }
    return tool;
  });
}

export interface PiDeclarationOptions {
  /**
   * `"prefer"` (default) falls back to ordinary tool calling where the
   * provider cannot enforce a schema; `"require"` fails the request
   * instead, so it suits only a pinned model known to support it.
   */
  constrainedSampling?: "prefer" | "require" | false;
}

/**
 * Validation failures and thrown executors both come back as error
 * results rather than exceptions, so a bad call costs the model a turn
 * instead of breaking the caller's loop.
 */
function dispatcher(
  entries: readonly PiToolEntry[],
): (call: PiToolCall, context?: ToolCallContext) => Promise<PiToolResult> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const nullable = new Map(entries.map((entry) => [entry.name, absentWhenNull(entry.inputSchema)]));
  return async (call, context = {}) => {
    const entry = byName.get(call.name);
    if (!entry) {
      return errorResult(
        `Unknown tool ${JSON.stringify(call.name)}. Available tools: ${entries
          .map((e) => JSON.stringify(e.name))
          .join(", ")}.`,
      );
    }

    const args = dropPlaceholderNulls(call.arguments ?? {}, nullable.get(entry.name) ?? EMPTY);
    const parsed = entry.inputSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${call.name}: ${formatZodError(parsed.error)}`);
    }

    const run = entry.execute as (
      i: unknown,
      c: ToolCallContext,
    ) => Promise<unknown> | AsyncIterable<unknown>;
    const toOutput = entry.toModelOutput as
      | ((args: { input: unknown; output: unknown }) => ModelOutput)
      | undefined;
    try {
      const output = await settle(run(parsed.data, context));
      return toPiResult(
        toOutput ? toOutput({ input: parsed.data, output }) : defaultModelOutput(output),
      );
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

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
      // pi's tool results carry images but nothing else, so a PDF
      // degrades to text rather than being dropped.
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
 * `io: "input"` keeps a field with a Zod `.default()` optional: the
 * default is emitted as a JSON Schema `default`.
 */
function toPiParameters(schema: z.ZodType): PiJSONSchema {
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    // Providers reject `$ref` pointers into a definitions section.
    reused: "inline",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") {
    throw new Error(`pi tool parameters must be an object schema, got ${String(json.type)}`);
  }
  return json as PiJSONSchema;
}

/**
 * The optional fields that do not accept null. Under strict sampling pi
 * makes every field required and lets the optional ones be null, so a
 * null there means the model left the field out.
 */
function absentWhenNull(schema: z.ZodType): ReadonlySet<string> {
  if (!(schema instanceof z.ZodObject)) return EMPTY;
  const names = new Set<string>();
  for (const [name, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    if (field.safeParse(undefined).success && !field.safeParse(null).success) names.add(name);
  }
  return names;
}

/**
 * Drops the nulls that stand for an absent field. A null on any other
 * field is a value the tool accepts (`exec`'s structured `input` is any
 * JSON) and survives.
 */
function dropPlaceholderNulls(args: unknown, nullable: ReadonlySet<string>): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  if (nullable.size === 0) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null && nullable.has(key)) continue;
    out[key] = value;
  }
  return out;
}

const EMPTY: ReadonlySet<string> = new Set();

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
