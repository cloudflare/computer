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
  // The backends `exec` may run on, each with a note for the model
  // ("" for none). The first is the default. Omit to offer every
  // backend the Workspace has. `{}` means no exec tool.
  exec?: ExecBackends;
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
  if (runtime !== undefined) {
    const exec = execOptions(options, runtime);
    if (Object.keys(exec.backends).length > 0) {
      tools.exec = createExecTool({ workspace: { runtime }, ...exec });
    }
  }

  if (options.assets !== false && options.workspace.assets !== undefined) {
    tools.publish = createPublishTool({ workspace: options.workspace as PublishWorkspaceLike });
  }

  return tools;
}

// Turn `exec`, or the deprecated `shell`, into createExecTool options.
function execOptions(
  options: CreateAIToolsOptions,
  runtime: ExecWorkspaceLike["runtime"],
): Omit<ExecToolOptions, "workspace"> & { backends: ExecBackends } {
  if (options.shell !== undefined) {
    const { backends, defaultBackend, ...limits } = options.shell;
    const ids = Object.keys(backends);
    const ordered =
      defaultBackend === undefined
        ? ids
        : [defaultBackend, ...ids.filter((id) => id !== defaultBackend)];
    return {
      ...limits,
      backends: Object.fromEntries(ordered.map((id) => [id, backends[id]?.description ?? ""])),
    };
  }
  if (options.exec !== undefined) return { backends: options.exec };
  return { backends: Object.fromEntries((runtime.backendIds?.() ?? []).map((id) => [id, ""])) };
}
