import type { ToolSet } from "ai";
import { createExecTool, type ExecToolOptions, type ExecWorkspaceLike } from "./exec.js";
import { createDeleteTool, type DeleteToolOptions } from "./fs/delete.js";
import { createEditTool, type EditToolOptions } from "./fs/edit.js";
import { createFindTool, type FindToolOptions } from "./fs/find.js";
import { createGrepTool, type GrepToolOptions } from "./fs/grep.js";
import { createListTool } from "./fs/list.js";
import { createReadTool, type ReadToolOptions } from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import { createWriteTool, type WriteToolOptions } from "./fs/write.js";
import { createPublishTool, type PublishWorkspaceLike } from "./publish.js";

export interface CreateAIToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<PublishWorkspaceLike>;
  readonly?: boolean;
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  find?: Omit<FindToolOptions, "workspace">;
  grep?: Omit<GrepToolOptions, "workspace">;
  delete?: Omit<DeleteToolOptions, "store">;
  shell?: Omit<ExecToolOptions, "workspace">;
}

export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const store = new WorkspaceFileStore(options.workspace);
  const tools: ToolSet = {
    read: createReadTool({ store, ...options.read }),
    ls: createListTool({ workspace: options.workspace }),
    find: createFindTool({ workspace: options.workspace, ...options.find }),
    grep: createGrepTool({ workspace: options.workspace, ...options.grep }),
  };

  if (options.readonly === true) return tools;

  tools.write = createWriteTool({ store, ...options.write });
  tools.edit = createEditTool({ store, ...options.edit });
  tools.delete = createDeleteTool({ store, ...options.delete });

  if (options.shell !== undefined) {
    tools.exec = createExecTool({
      workspace: options.workspace as ExecWorkspaceLike,
      ...options.shell,
    });
  }

  if (options.assets !== false && options.workspace.assets !== undefined) {
    tools.publish = createPublishTool({ workspace: options.workspace as PublishWorkspaceLike });
  }

  return tools;
}
