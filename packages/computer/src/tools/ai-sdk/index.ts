import type { ToolSet } from "ai";
import { type CreateToolsOptions, resolveToolOptions } from "../common/options.js";
import type { PublishWorkspaceLike } from "../common/publish.js";
import {
  createDeleteTool,
  createEditTool,
  createExecTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createPublishTool,
  createReadTool,
  createWriteTool,
} from "./tools.js";

/** Options for {@link createAITools}. */
export type CreateAIToolsOptions = CreateToolsOptions;

export {
  createDeleteTool,
  createEditTool,
  createExecTool,
  createFindTool,
  createGrepTool,
  createListTool,
  createPublishTool,
  createReadTool,
  createWriteTool,
} from "./tools.js";

/**
 * Build the AI SDK tool set for a Workspace: `read`, `ls`, `find`, and
 * `grep`, plus `write`, `edit`, `delete`, `exec`, and `publish` unless
 * the set is read-only. `exec` offers every backend the Workspace has
 * unless `exec` picks them.
 *
 * @param options - The Workspace and per-tool options.
 * @returns An AI SDK `ToolSet` for `generateText`, `streamText`, or an agent's `getTools()`.
 */
export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const resolved = resolveToolOptions(options);
  const workspace = resolved.workspace;

  const tools: ToolSet = {
    read: createReadTool(resolved.read),
    ls: createListTool({ workspace }),
    find: createFindTool({ workspace }),
    grep: createGrepTool({ workspace }),
  };

  if (resolved.readonly) return tools;

  tools.write = createWriteTool(resolved.write);
  tools.edit = createEditTool(resolved.edit);
  tools.delete = createDeleteTool(resolved.delete);

  if (resolved.exec !== undefined) {
    tools.exec = createExecTool(resolved.exec);
  }

  if (resolved.publish) {
    tools.publish = createPublishTool({ workspace: workspace as PublishWorkspaceLike });
  }

  return tools;
}
