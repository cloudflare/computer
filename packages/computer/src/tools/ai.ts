/**
 * Tools for the [AI SDK](https://github.com/vercel/ai) (`ai`).
 *
 * The AI SDK is the closest match to the shared spec shape: it takes a
 * Zod `inputSchema`, an `execute` that may return an async iterable of
 * progressive results, and an optional `toModelOutput`. So this adapter
 * forwards the specs from `./registry.js` almost unchanged, lowering
 * only the neutral `ModelOutput` onto the SDK's output parts.
 */

import { type Tool, type ToolSet, tool } from "ai";
import { toAISDKOutput } from "./ai-output.js";
import { type CreateToolsOptions, createToolSpecs } from "./registry.js";
import { type AnyToolSpec, applyModelOutput, runSpec, type ToolSpecSet } from "./spec.js";

export type CreateAIToolsOptions = CreateToolsOptions;

/**
 * Create the AI SDK `ToolSet` for a Workspace.
 *
 * Always includes `read`, `ls`, `find`, and `grep`. Adds `write`,
 * `edit`, and `delete` unless `readonly` is set, `exec` when `shell`
 * options are supplied, and `publish` when assets are configured.
 */
export function createAITools(options: CreateAIToolsOptions): ToolSet {
  return toAITools(createToolSpecs(options));
}

/** Adapt an existing spec set to AI SDK tools. */
export function toAITools(specs: ToolSpecSet): ToolSet {
  const tools: ToolSet = {};
  for (const spec of Object.values(specs)) {
    tools[spec.name] = toAITool(spec);
  }
  return tools;
}

function toAITool(spec: AnyToolSpec): Tool {
  const hasModelOutput = spec.toModelOutput !== undefined;
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    // The AI SDK accepts either a promise or an async iterable from
    // `execute`, which is the same contract a spec executor follows, so
    // the return value passes straight through and a streaming tool
    // keeps its progressive snapshots.
    execute: (input: unknown, { abortSignal }: { abortSignal?: AbortSignal }) =>
      runSpec(spec, input, { abortSignal }),
    ...(hasModelOutput
      ? {
          toModelOutput: async ({ input, output }: { input: unknown; output: unknown }) =>
            toAISDKOutput(await applyModelOutput(spec, input, output)),
        }
      : {}),
  }) as Tool;
}
