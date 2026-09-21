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
 * Each tool is declared here in pi's own terms. The executors and Zod
 * schemas come from `../common`, which holds the workspace logic that
 * is genuinely not provider-specific; pi's declarations, its JSON
 * Schema conversion, and its result encoding are written out in this
 * file rather than derived from a shared tool abstraction.
 *
 * TypeBox schemas are plain JSON Schema and pi validates against them
 * with TypeBox's validator, so the Zod schemas are converted here
 * rather than rewritten by hand.
 */

import { z } from "zod";
import { createExecExecutor, execDescription, execInputSchema } from "../common/exec.js";
import { deleteDescription, deleteFromStore, deleteInputSchema } from "../common/fs/delete.js";
import { editDescription, editInputSchema, editInStore } from "../common/fs/edit.js";
import {
  type FindWorkspaceLike,
  findDescription,
  findInputSchema,
  findInWorkspace,
} from "../common/fs/find.js";
import {
  type GrepWorkspaceLike,
  grepDescription,
  grepInputSchema,
  grepInWorkspace,
} from "../common/fs/grep.js";
import {
  type ListWorkspaceLike,
  listDescription,
  listInputSchema,
  listWorkspace,
} from "../common/fs/list.js";
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

/**
 * Per-call information an executor may use.
 *
 * Only cancellation is portable, so that is all this carries. Keeping
 * it an object rather than a bare signal lets later additions stay
 * backward compatible.
 */
export interface ToolCallContext {
  abortSignal?: AbortSignal;
}

/**
 * One workspace tool as pi needs it.
 *
 * Internal to this module: the declaration fields pi sends to the
 * model, plus how to run the tool and how to present its result.
 */
interface PiToolEntry {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** Close the schema and constrain sampling for fussy arguments. */
  strictArguments?: boolean;
  execute: (input: never, context: ToolCallContext) => Promise<unknown> | AsyncIterable<unknown>;
  toModelOutput?: (args: { input: never; output: never }) => ModelOutput;
}

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
  /**
   * Provider-side constrained sampling, when the tool asks for it.
   *
   * `strict: "prefer"` rather than `"require"` so a provider or model
   * that cannot enforce a schema falls back to ordinary tool calling
   * instead of failing the request.
   */
  constrainedSampling?: { type: "json_schema"; strict: "prefer" | "require" };
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
export function createPiTools(options: CreatePiToolsOptions): CreatePiToolsResult {
  const entries = piToolEntries(options);
  const nullable = new Map<string, ReadonlySet<string>>();
  return {
    tools: declarations(entries, options, nullable),
    execute: dispatcher(entries, nullable),
  };
}

export interface CreatePiToolsOptions extends CreateToolsOptions, PiDeclarationOptions {}

/**
 * The workspace tools pi offers, in pi's own terms.
 *
 * Always includes `read`, `ls`, `find`, and `grep`. Adds `write`,
 * `edit`, and `delete` unless `readonly` is set, `exec` when `shell`
 * options are supplied, and `publish` when assets are configured.
 */
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
      // Positioned reads hand back byte offsets the model must echo
      // back verbatim on the next call, so constrain them.
      strictArguments: true,
      execute: (input: ReadInput) => readExecutor(input),
      toModelOutput: ({ input, output }: { input: ReadInput; output: ReadToolResult }) =>
        toReadOutput({ input, output }),
    } as PiToolEntry,
    {
      name: "ls",
      description: listDescription,
      inputSchema: listInputSchema,
      execute: (input) => listWorkspace(workspace as ListWorkspaceLike, input),
    } as PiToolEntry,
    {
      name: "find",
      description: findDescription,
      inputSchema: findInputSchema,
      execute: (input) => findInWorkspace(workspace as FindWorkspaceLike, input),
    } as PiToolEntry,
    {
      name: "grep",
      description: grepDescription,
      inputSchema: grepInputSchema,
      execute: (input) => grepInWorkspace(workspace as GrepWorkspaceLike, input),
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
      // A nested array of exact-match strings is the easiest shape for
      // a model to malform, and a malformed edit costs a whole turn.
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
    const executor = createExecExecutor(resolved.exec);
    entries.push({
      name: "exec",
      description: execDescription(resolved.exec),
      inputSchema: execInputSchema(resolved.exec),
      execute: (input, context) => executor(input, context),
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

/** Build the declarations pi puts in `Context.tools`. */
function declarations(
  entries: readonly PiToolEntry[],
  options: PiDeclarationOptions,
  nullable: Map<string, ReadonlySet<string>>,
): PiTool[] {
  const strict = options.constrainedSampling ?? "prefer";
  return entries.map((entry) => {
    // Strict schemas must close the object: a provider enforcing the
    // schema has to know no other properties are allowed.
    const wantsStrict = strict !== false && entry.strictArguments === true;
    const converted = toPiParameters(entry.inputSchema, wantsStrict);
    nullable.set(entry.name, converted.nullable);
    const tool: PiTool = {
      name: entry.name,
      description: entry.description,
      parameters: converted.parameters,
    };
    if (wantsStrict) {
      tool.constrainedSampling = { type: "json_schema", strict };
    }
    return tool;
  });
}

export interface PiDeclarationOptions {
  /**
   * Whether to request provider-side constrained sampling for the tools
   * that ask for it, and how strictly.
   *
   * `"prefer"` (the default) falls back to ordinary tool calling on a
   * provider that cannot enforce the schema. `"require"` fails the
   * request instead, which is only appropriate when the caller pins a
   * model known to support it. `false` opts out entirely.
   */
  constrainedSampling?: "prefer" | "require" | false;
}

/**
 * Build the dispatcher that runs one tool call.
 *
 * Arguments are validated against the tool's own Zod schema before the
 * executor runs. pi's loop may also validate with `validateToolCall`;
 * validating here as well means a caller that skips that step still
 * cannot reach an executor with malformed input, and a validation
 * failure comes back as an error result the model can retry against
 * rather than a thrown exception that breaks the loop.
 */
function dispatcher(
  entries: readonly PiToolEntry[],
  nullable: ReadonlyMap<string, ReadonlySet<string>>,
): (call: PiToolCall, context?: ToolCallContext) => Promise<PiToolResult> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return async (call, context = {}) => {
    const entry = byName.get(call.name);
    if (!entry) {
      return errorResult(
        `Unknown tool ${JSON.stringify(call.name)}. Available tools: ${entries
          .map((e) => JSON.stringify(e.name))
          .join(", ")}.`,
      );
    }

    // Strict schemas require every property, expressing "absent" as
    // null. Drop those placeholders, but only for the fields that were
    // widened, so a null the tool genuinely accepts survives.
    const args = dropPlaceholderNulls(call.arguments ?? {}, nullable.get(entry.name) ?? EMPTY);
    const parsed = entry.inputSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${call.name}: ${formatZodError(parsed.error)}`);
    }

    let output: unknown;
    try {
      const run = entry.execute as (
        i: unknown,
        c: ToolCallContext,
      ) => Promise<unknown> | AsyncIterable<unknown>;
      output = await settle(run(parsed.data, context));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const toOutput = entry.toModelOutput as
      | ((args: { input: unknown; output: unknown }) => ModelOutput)
      | undefined;
    return toPiResult(
      toOutput ? toOutput({ input: parsed.data, output }) : defaultModelOutput(output),
    );
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
function toPiParameters(
  schema: z.ZodType,
  strict = false,
): { parameters: PiJSONSchema; nullable: Set<string> } {
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
  // A provider enforcing a JSON schema needs the object closed, and
  // OpenAI additionally requires every property to be listed in
  // `required` — optional fields are expressed as nullable instead. Zod
  // emits the open, minimally-required form, so close it here rather
  // than restating each schema for the strict case.
  const nullable = new Set<string>();
  if (strict) {
    json.additionalProperties = false;
    const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
    const names = Object.keys(properties);
    const required = new Set((json.required as string[] | undefined) ?? []);
    for (const name of names) {
      if (required.has(name)) continue;
      const property = properties[name];
      const type = property.type;
      // Widen an optional property to accept null, so the model can
      // fill the now-required slot without inventing a value. Record it,
      // so the dispatcher knows this null means "absent" rather than a
      // value the tool asked for.
      if (typeof type === "string" && type !== "null") {
        property.type = [type, "null"];
        nullable.add(name);
      }
    }
    json.required = names;
  }
  return { parameters: json as PiJSONSchema, nullable };
}

/**
 * Drop the null placeholders strict mode introduced, and only those.
 *
 * A closed schema has to list every property as required, so an omitted
 * optional field is sent as null instead. Those nulls mean "absent" and
 * have to go before Zod sees them. A null the tool genuinely accepts
 * must survive: `exec`'s structured `input` is any JSON value, so a
 * model passing null there means it.
 *
 * `nullable` names the fields this adapter widened for one tool, so
 * only those are stripped.
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
