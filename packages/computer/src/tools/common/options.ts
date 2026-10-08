import type { ExecBackends, ExecToolOptions, ExecWorkspaceLike } from "./exec.js";
import type { EditToolOptions } from "./fs/edit.js";
import type { ReadToolOptions } from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import type { WriteToolOptions } from "./fs/write.js";
import type { PublishWorkspaceLike } from "./publish.js";

/** Options every tool set takes: `createAITools`, `createPiTools`, and `createTanStackTools`. */
export interface CreateToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<PublishWorkspaceLike>;
  /** Omit `write`, `edit`, `delete`, `exec`, and `publish`. */
  readonly?: boolean;
  /** Set `false` to omit `publish` even when assets are configured. */
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  /**
   * The backends `exec` may run on, keyed by id, each with an optional
   * description for the model. Omit to offer every backend the
   * Workspace has; `{}` means no exec tool.
   */
  exec?: ExecBackends;
  execOutput?: Pick<ExecToolOptions, "maxBytes" | "maxLines">;
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

export interface ResolvedToolOptions {
  read: ReadToolOptions;
  write: WriteToolOptions;
  edit: EditToolOptions;
  delete: { store: WorkspaceFileStore };
  /** Absent when the set is read-only, the Workspace has no runtime, or no backend is selected. */
  exec?: ExecToolOptions;
  publish: boolean;
  readonly: boolean;
  workspace: CreateToolsOptions["workspace"];
}

/** Resolve the options into what each tool needs, so every tool set offers the same tools. */
export function resolveToolOptions(options: CreateToolsOptions): ResolvedToolOptions {
  const store = new WorkspaceFileStore(options.workspace);
  const readonly = options.readonly === true;
  return {
    read: { store, ...options.read },
    write: { store, ...options.write },
    edit: { store, ...options.edit },
    delete: { store },
    exec: readonly ? undefined : execOptions(options),
    publish: !readonly && options.assets !== false && options.workspace.assets !== undefined,
    readonly,
    workspace: options.workspace,
  };
}

// Turn `exec`, or the deprecated `shell`, into exec tool options.
function execOptions(options: CreateToolsOptions): ExecToolOptions | undefined {
  const runtime = options.workspace.runtime;
  if (runtime === undefined) return undefined;
  const exec = selectExec(options, runtime);
  if (Object.keys(exec.backends).length === 0) return undefined;
  const output = options.execOutput;
  return {
    workspace: { runtime },
    ...exec,
    ...(output?.maxBytes === undefined ? {} : { maxBytes: output.maxBytes }),
    ...(output?.maxLines === undefined ? {} : { maxLines: output.maxLines }),
  };
}

function selectExec(
  options: CreateToolsOptions,
  runtime: ExecWorkspaceLike["runtime"],
): Omit<ExecToolOptions, "workspace"> & { backends: ExecBackends } {
  // `exec` wins over the deprecated `shell`, so `exec: {}` always means
  // no exec tool.
  if (options.exec !== undefined) return { backends: options.exec };
  if (options.shell !== undefined) {
    const { backends, defaultBackend: _ignored, ...limits } = options.shell;
    return { ...limits, backends };
  }
  return { backends: Object.fromEntries((runtime.backends?.() ?? []).map(({ id }) => [id, {}])) };
}
