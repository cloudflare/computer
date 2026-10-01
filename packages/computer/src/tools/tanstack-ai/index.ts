/**
 * `inputSchema` is a Standard Schema, which Zod v4 implements, so the
 * schemas from `../common` are passed through untouched.
 */

import type { z } from "zod";
import { defineExec } from "../common/exec.js";
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
import {
  writeDescription,
  writeInputSchema,
  writeOutputSchema,
  writeToStore,
} from "../common/fs/write.js";
import { defaultModelOutput, type ModelOutput } from "../common/model-output.js";
import { type CreateToolsOptions, resolveToolOptions } from "../common/options.js";
import {
  createPublishExecutor,
  type PublishWorkspaceLike,
  publishDescription,
  publishInputSchema,
  publishOutputSchema,
} from "../common/publish.js";
import { isAsyncIterable, settle } from "../common/stream.js";

/** Structurally compatible with `toolDefinition().server()`, declared locally so `@tanstack/ai` is not a build-time dependency. */
export interface TanStackTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType;
  // biome-ignore lint/suspicious/noExplicitAny: matches the signature chat() calls
  execute: (input: any, context?: TanStackToolExecutionContext) => Promise<unknown>;
  needsApproval?: boolean;
  lazy?: boolean;
  /** Phantom marker carrying no runtime value; declaring it satisfies the union `chat({ tools })` accepts. */
  readonly "~toolKind"?: undefined;
}

export interface TanStackToolExecutionContext {
  toolCallId?: string;
  /** Fires when the chat run's `abortController` aborts; a running `exec` is killed. */
  abortSignal?: AbortSignal;
  emitCustomEvent?: (eventName: string, value: Record<string, unknown>) => void;
}

export type TanStackToolList = TanStackTool<never>[];

export type TanStackToolSet = Record<string, TanStackTool<never>>;

/** `chat()`, `mergeAgentTools` and `createToolRegistry` all take an array, so `"array"` is the default. */
export type TanStackToolFormat = "array" | "object";

export type TanStackToolsFor<Format extends TanStackToolFormat> = Format extends "object"
  ? TanStackToolSet
  : TanStackToolList;

export interface CreateTanStackToolsOptions<Format extends TanStackToolFormat = "array">
  extends CreateToolsOptions {
  format?: Format;
  /** Tools that pause for approval. `"mutating"` selects every tool that changes workspace state. */
  approve?: string[] | "mutating";
  /** Forward pre-terminal `exec` snapshots through `emitCustomEvent` under this name; otherwise they are discarded. */
  streamEventName?: string;
  /** Tools withheld from the prompt until TanStack lazy discovery asks for them. */
  lazy?: string[] | "all";
}

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
      // TanStack validates every return against this, errors included,
      // so a success-only schema would mask the real failure reason.
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
    run: async (input: never) => plain(await listWorkspace(workspace, input)),
  });

  add({
    name: "find",
    description: findDescription,
    inputSchema: findInputSchema,
    run: async (input: never) => plain(await findInWorkspace(workspace, input)),
  });

  add({
    name: "grep",
    description: grepDescription,
    inputSchema: grepInputSchema,
    run: async (input: never) => plain(await grepInWorkspace(workspace, input)),
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
      const exec = defineExec(resolved.exec);
      add({
        name: "exec",
        description: exec.description,
        inputSchema: exec.inputSchema,
        mutates: true,
        streams: true,
        run: async (input: never, context?: TanStackToolExecutionContext) => {
          const returned = exec.execute(input, { abortSignal: context?.abortSignal });
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

function plain(output: unknown): unknown {
  return toTanStackOutput(defaultModelOutput(output));
}

/**
 * Running snapshots are emitted as they arrive, so a command that
 * prints once and goes quiet shows that output straight away. The
 * terminal snapshot is returned rather than emitted, so a consumer
 * ignoring custom events still sees the complete outcome.
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
    if (isRunning(chunk)) {
      emit(eventName, { toolCallId: context?.toolCallId, snapshot: chunk as never });
    }
    last = chunk;
    seen = true;
  }
  if (!seen) throw new Error("tool executor yielded no result");
  return last as Output;
}

/** An exec snapshot is running until it carries an exit code or an error. */
function isRunning(snapshot: unknown): boolean {
  const s = snapshot as { exitCode?: unknown; error?: unknown };
  return s.exitCode === null && s.error === undefined;
}

function wants(option: string[] | string | undefined, name: string, byTrait: boolean): boolean {
  if (option === undefined) return false;
  if (Array.isArray(option)) return option.includes(name);
  return byTrait;
}

/**
 * TanStack passes a tool result through as multimodal content only when
 * it is an array of content parts; anything else is JSON-stringified. So
 * an image or PDF comes back as a text part plus an `image` or
 * `document` part, which the adapter attaches rather than sending the
 * base64 as text.
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
      return [
        { type: "text", content: output.text },
        {
          type: output.mediaType.startsWith("image/") ? "image" : "document",
          source: { type: "data", value: output.data, mimeType: output.mediaType },
        },
      ];
  }
}
