/**
 * Tools for [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai`).
 *
 * A TanStack tool is a plain object with a `name`, a `description`, an
 * `inputSchema`, and an `execute`. `inputSchema` is a Standard Schema,
 * which Zod v4 implements, so the Zod schemas in `../common` are passed
 * through untouched — no conversion and no second copy of any schema.
 *
 * Each tool is declared here in TanStack's own terms. The executors and
 * schemas come from `../common`, which holds the workspace logic that
 * is genuinely not provider-specific; what TanStack sees is written out
 * in this file rather than derived from a shared tool abstraction.
 *
 * `createTanStackTools` returns a list, which is what every TanStack
 * entry point takes: `chat({ tools })`, `mergeAgentTools`, and
 * `createToolRegistry` all want an array. Pass `format: "object"` to
 * get the same tools keyed by name, for reaching one directly.
 */

import type { z } from "zod";
import { createExecExecutor, execDescription, execInputSchema } from "../common/exec.js";
import {
  deleteDescription,
  deleteFromStore,
  deleteInputSchema,
  deleteOutputSchema,
} from "../common/fs/delete.js";
import {
  editDescription,
  editInputSchema,
  editInStore,
  editOutputSchema,
} from "../common/fs/edit.js";
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
import {
  writeDescription,
  writeInputSchema,
  writeOutputSchema,
  writeToStore,
} from "../common/fs/write.js";
import { defaultModelOutput, type ModelOutput, modelOutputToText } from "../common/model-output.js";
import { type CreateToolsOptions, resolveToolOptions } from "../common/options.js";
import {
  createPublishExecutor,
  type PublishWorkspaceLike,
  publishDescription,
  publishInputSchema,
  publishOutputSchema,
} from "../common/publish.js";
import { settle } from "../common/stream.js";

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
 * A list of tools, ready to pass to `chat({ tools })`.
 *
 * The element type erases its input to `never` because `chat()` accepts
 * a tool whose `execute` takes `any`, and a spec validates its own
 * input before use, so the looser parameter is accurate here.
 */
export type TanStackToolList = TanStackTool<never>[];

/**
 * The same tools keyed by name.
 *
 * No TanStack entry point takes this shape — it is for reaching one
 * tool directly, such as to adjust a single tool before the call.
 */
export type TanStackToolSet = Record<string, TanStackTool<never>>;

/**
 * Which shape the builders return.
 *
 * Defaults to `"array"`, because that is what every TanStack entry
 * point takes: `chat({ tools })`, `mergeAgentTools`, and
 * `createToolRegistry` all call array methods on what they are given.
 * `"object"` keys the same tools by name, for a caller that reaches
 * one tool directly rather than passing the set along.
 */
export type TanStackToolFormat = "array" | "object";

/** Return shape for a given {@link TanStackToolFormat}. */
export type TanStackToolsFor<Format extends TanStackToolFormat> = Format extends "object"
  ? TanStackToolSet
  : TanStackToolList;

export interface CreateTanStackToolsOptions<Format extends TanStackToolFormat = "array">
  extends CreateToolsOptions {
  /**
   * Shape to return the tools in. Defaults to `"array"`, which is what
   * every TanStack entry point takes. Pass `"object"` to get them
   * keyed by name instead, for reaching one tool directly.
   */
  format?: Format;
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
 * Build the TanStack AI tools for a Workspace.
 *
 * Returns a list, ready to pass straight to `chat({ tools })`. It holds
 * the same tools, caps, and gating as the AI SDK and pi entrypoints.
 * Pass `format: "object"` to get them keyed by name instead.
 */
export function createTanStackTools<Format extends TanStackToolFormat = "array">(
  options: CreateTanStackToolsOptions<Format>,
): TanStackToolsFor<Format> {
  const resolved = resolveToolOptions(options);
  const workspace = resolved.workspace;
  const readExecutor = createReadExecutor(resolved.read);
  const toReadOutput = readModelOutput(resolved.read);

  const tools: TanStackToolList = [];
  const add = (entry: {
    name: string;
    description: string;
    inputSchema: z.ZodType;
    outputSchema?: z.ZodType;
    mutates?: boolean;
    streams?: boolean;
    run: (input: never, context?: TanStackToolExecutionContext) => unknown;
  }) => {
    const needsApproval = wants(options.approve, entry.name, entry.mutates === true);
    const lazy = wants(options.lazy, entry.name, options.lazy === "all");
    tools.push({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      // TanStack validates every return against this, including the
      // error branch, so a schema has to describe both outcomes. A
      // success-only schema would replace a real failure reason with a
      // schema complaint.
      outputSchema: entry.outputSchema,
      needsApproval: needsApproval ? true : undefined,
      lazy: lazy ? true : undefined,
      execute: entry.run,
    } as TanStackTool<never>);
  };

  add({
    name: "read",
    description: readDescription(resolved.read),
    inputSchema: readInputSchema,
    run: async (input: ReadInput) => {
      const output = (await readExecutor(input)) as ReadToolResult;
      return toTanStackOutput(toReadOutput({ input, output }));
    },
  });

  add({
    name: "ls",
    description: listDescription,
    inputSchema: listInputSchema,
    run: async (input: never) => plain(await listWorkspace(workspace as ListWorkspaceLike, input)),
  });

  add({
    name: "find",
    description: findDescription,
    inputSchema: findInputSchema,
    run: async (input: never) =>
      plain(await findInWorkspace(workspace as FindWorkspaceLike, input)),
  });

  add({
    name: "grep",
    description: grepDescription,
    inputSchema: grepInputSchema,
    run: async (input: never) =>
      plain(await grepInWorkspace(workspace as GrepWorkspaceLike, input)),
  });

  if (!resolved.readonly) {
    add({
      name: "write",
      description: writeDescription,
      inputSchema: writeInputSchema,
      outputSchema: writeOutputSchema,
      mutates: true,
      run: async (input: never) => plain(await writeToStore(resolved.write, input)),
    });

    add({
      name: "edit",
      description: editDescription,
      inputSchema: editInputSchema,
      outputSchema: editOutputSchema,
      mutates: true,
      run: async (input: never) => plain(await editInStore(resolved.edit, input)),
    });

    add({
      name: "delete",
      description: deleteDescription,
      inputSchema: deleteInputSchema,
      outputSchema: deleteOutputSchema,
      mutates: true,
      run: async (input: never) => plain(await deleteFromStore(resolved.delete, input)),
    });

    if (resolved.exec !== undefined) {
      const executor = createExecExecutor(resolved.exec);
      add({
        name: "exec",
        description: execDescription(resolved.exec),
        inputSchema: execInputSchema(resolved.exec),
        mutates: true,
        streams: true,
        run: async (input: never, context?: TanStackToolExecutionContext) => {
          const returned = executor(input, { abortSignal: options.signal });
          const output = options.streamEventName
            ? await settleWithEvents(returned, options.streamEventName, context)
            : await settle(returned);
          return plain(output);
        },
      });
    }

    if (resolved.publish) {
      const executor = createPublishExecutor(workspace as PublishWorkspaceLike);
      add({
        name: "publish",
        description: publishDescription,
        inputSchema: publishInputSchema,
        outputSchema: publishOutputSchema,
        mutates: true,
        run: async (input: never) => plain(await executor(input)),
      });
    }
  }

  if (options.format === "object") {
    const set: TanStackToolSet = {};
    for (const tool of tools) set[tool.name] = tool;
    // The generic resolves to one branch or the other at each call
    // site, which a return inside the function cannot prove.
    return set as TanStackToolsFor<Format>;
  }
  return tools as TanStackToolsFor<Format>;
}

/**
 * Present a plain executor result to the model.
 *
 * TanStack serializes whatever a tool returns, so a structured result
 * stays an object and only an `{ error }` needs the neutral treatment
 * that turns it into TanStack's error shape.
 */
function plain(output: unknown): unknown {
  return toTanStackOutput(defaultModelOutput(output));
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
