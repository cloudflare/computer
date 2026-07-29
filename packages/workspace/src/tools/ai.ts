import type { ToolSet } from "ai";
import { createExecTool, type ExecToolOptions, type ExecWorkspaceLike } from "./exec.js";
import { createEditTool, type EditToolOptions } from "./fs/edit.js";
import { createListTool } from "./fs/list.js";
import { createReadTool, type ReadToolOptions } from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import { createWriteTool, type WriteToolOptions } from "./fs/write.js";
import { createShareTool, type ShareWorkspaceLike } from "./share.js";

export interface CreateAIToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<ShareWorkspaceLike>;
  readonly?: boolean;
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  shell?: Omit<ExecToolOptions, "workspace">;
}

export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const store = new WorkspaceFileStore(options.workspace);
  const tools: ToolSet = {
    read: createReadTool({ store, ...options.read }),
    ls: createListTool({ workspace: options.workspace }),
  };

  if (options.readonly === true) return tools;

  tools.write = createWriteTool({ store, ...options.write });
  tools.edit = createEditTool({ store, ...options.edit });

  if (options.shell !== undefined) {
    tools.exec = createExecTool({
      workspace: options.workspace as ExecWorkspaceLike,
      ...options.shell,
    });
  }

  if (options.assets !== false && options.workspace.assets !== undefined) {
    tools.share = createShareTool({ workspace: options.workspace as ShareWorkspaceLike });
  }

  return tools;
}
