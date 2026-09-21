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
