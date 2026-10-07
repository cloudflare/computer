import type { ExecToolOptions, ExecWorkspaceLike } from "./exec.js";
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
  /** The backends `exec` may run on and which one it uses by default. Omit for no exec tool. */
  shell?: Omit<ExecToolOptions, "workspace">;
}

export interface ResolvedToolOptions {
  read: ReadToolOptions;
  write: WriteToolOptions;
  edit: EditToolOptions;
  delete: { store: WorkspaceFileStore };
  /** Absent when the set is read-only or `shell` is not given. */
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

// Pair `shell` with the Workspace's runtime.
function execOptions(options: CreateToolsOptions): ExecToolOptions | undefined {
  if (options.shell === undefined) return undefined;
  return { workspace: options.workspace as ExecWorkspaceLike, ...options.shell };
}
