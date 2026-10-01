import type { ToolSet } from "ai";
import {
  createExecTool,
  type ExecBackends,
  type ExecToolOptions,
  type ExecWorkspaceLike,
} from "./exec.js";
import { createDeleteTool } from "./fs/delete.js";
import { createEditTool, type EditToolOptions } from "./fs/edit.js";
import { createFindTool } from "./fs/find.js";
import { createGrepTool } from "./fs/grep.js";
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
  // Which backends `exec` may run on: a list of backend ids, or a map
  // from id to text for the model (`true` for none). The first is the
  // default. Omit to offer every backend the Workspace has; pass
  // `false` for no exec tool.
  exec?: ExecBackends | false;
  /**
   * @deprecated Use `exec`. `{ backends: { id: { description } },
   * defaultBackend }` becomes `exec: { id: description }` with the
   * default listed first. Output limits move to `createExecTool`.
   */
  shell?: LegacyShellOptions;
}

interface LegacyShellOptions extends Omit<ExecToolOptions, "workspace" | "backends"> {
  backends: Record<string, { description?: string }>;
  defaultBackend?: string;
}

export function createAITools(options: CreateAIToolsOptions): ToolSet {
  const store = new WorkspaceFileStore(options.workspace);
  const tools: ToolSet = {
    read: createReadTool({ store, ...options.read }),
    ls: createListTool({ workspace: options.workspace }),
    find: createFindTool({ workspace: options.workspace }),
    grep: createGrepTool({ workspace: options.workspace }),
  };

  if (options.readonly === true) return tools;

  tools.write = createWriteTool({ store, ...options.write });
  tools.edit = createEditTool({ store, ...options.edit });
  tools.delete = createDeleteTool({ store });

  const runtime = options.workspace.runtime;
  if (runtime !== undefined && options.exec !== false) {
    const exec = execOptions(options);
    if (exec.backends !== undefined || (runtime.backendIds?.().length ?? 0) > 0) {
      tools.exec = createExecTool({ workspace: { runtime }, ...exec });
    }
  }

  if (options.assets !== false && options.workspace.assets !== undefined) {
    tools.publish = createPublishTool({ workspace: options.workspace as PublishWorkspaceLike });
  }

  return tools;
}

// Turn `exec`, or the deprecated `shell`, into createExecTool options.
function execOptions(options: CreateAIToolsOptions): Omit<ExecToolOptions, "workspace"> {
  if (options.shell === undefined) {
    return options.exec === undefined || options.exec === false ? {} : { backends: options.exec };
  }
  const { backends, defaultBackend, ...limits } = options.shell;
  const ids = Object.keys(backends);
  const ordered =
    defaultBackend === undefined
      ? ids
      : [defaultBackend, ...ids.filter((id) => id !== defaultBackend)];
  return {
    ...limits,
    backends: Object.fromEntries(ordered.map((id) => [id, backends[id]?.description ?? true])),
  };
}
