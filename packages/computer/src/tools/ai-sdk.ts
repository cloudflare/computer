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

/** Options for {@link createAITools}. */
export interface CreateAIToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<PublishWorkspaceLike>;
  readonly?: boolean;
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  // The backends `exec` may run on, keyed by id, each with an optional
  // description for the model. Omit to offer
  // every backend the Workspace has; `{}` means no exec tool.
  exec?: ExecBackends;
  /**
   * @deprecated Use `exec`. `{ backends }` becomes `exec: backends`;
   * `defaultBackend` is ignored, because the model names a backend
   * whenever there is a choice. Output limits move to `createExecTool`.
   */
  shell?: LegacyShellOptions;
}

interface LegacyShellOptions extends Omit<ExecToolOptions, "workspace" | "backends"> {
  backends: ExecBackends;
  defaultBackend?: string;
}

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
  // `exec` wins over the deprecated `shell`, so `exec: {}` always means
  // no exec tool.
  if (options.exec !== undefined) return { backends: options.exec };
  if (options.shell !== undefined) {
    const { backends, defaultBackend: _ignored, ...limits } = options.shell;
    return { ...limits, backends };
  }
  return { backends: Object.fromEntries((runtime.backendIds?.() ?? []).map((id) => [id, {}])) };
}
