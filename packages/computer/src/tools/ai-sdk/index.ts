/**
 * Tools for the [AI SDK](https://github.com/vercel/ai) (`ai`).
 *
 * Each tool is declared in the AI SDK's own terms in `./tools.js`,
 * using its `tool()` helper and its `toModelOutput` encoding. The
 * executors and Zod schemas come from `../common`, which holds the
 * workspace logic that is genuinely not provider-specific.
 *
 * This module assembles those tools into a set, applying the shared
 * inclusion rules — `readonly`, `shell`, `assets` — so the same options
 * select the same tools here as under pi and TanStack AI.
 */

import type { ToolSet } from "ai";
import type { FindWorkspaceLike } from "../common/fs/find.js";
import type { GrepWorkspaceLike } from "../common/fs/grep.js";
import type { ListWorkspaceLike } from "../common/fs/list.js";
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

export type CreateAIToolsOptions = CreateToolsOptions;

// The same tools one at a time, for a caller assembling a bespoke set.
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
 * Create the AI SDK `ToolSet` for a Workspace.
 *
 * Always includes `read`, `ls`, `find`, and `grep`. Adds `write`,
 * `edit`, and `delete` unless `readonly` is set, `exec` when `shell`
 * options are supplied, and `publish` when assets are configured.
 */
export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const resolved = resolveToolOptions(options);
  const workspace = resolved.workspace;

  const tools: ToolSet = {
    read: createReadTool(resolved.read),
    ls: createListTool({ workspace: workspace as ListWorkspaceLike }),
    find: createFindTool({ workspace: workspace as FindWorkspaceLike }),
    grep: createGrepTool({ workspace: workspace as GrepWorkspaceLike }),
  };

  if (resolved.readonly) return tools;

  tools.write = createWriteTool(resolved.write);
  tools.edit = createEditTool(resolved.edit);
  tools.delete = createDeleteTool(resolved.delete);

  if (resolved.exec !== undefined) {
    tools.exec = createExecTool(resolved.exec) as ToolSet[string];
  }

  if (resolved.publish) {
    tools.publish = createPublishTool({ workspace: workspace as PublishWorkspaceLike });
  }

  return tools;
}
