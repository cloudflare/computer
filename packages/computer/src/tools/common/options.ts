import type { ExecToolOptions, ExecWorkspaceLike } from "./exec.js";
import type { EditToolOptions } from "./fs/edit.js";
import type { ReadToolOptions } from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import type { WriteToolOptions } from "./fs/write.js";
import type { PublishWorkspaceLike } from "./publish.js";

export interface CreateToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<PublishWorkspaceLike>;
  /** Omit `write`, `edit`, `delete`, `exec`, and `publish`. */
  readonly?: boolean;
  /** Set `false` to omit `publish` even when assets are configured. */
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  /** Pass to add `exec`. Omit to leave command execution out entirely. */
  shell?: Omit<ExecToolOptions, "workspace">;
}

export interface ResolvedToolOptions {
  read: ReadToolOptions;
  write: WriteToolOptions;
  edit: EditToolOptions;
  delete: { store: WorkspaceFileStore };
  exec?: ExecToolOptions;
  publish: boolean;
  readonly: boolean;
  workspace: CreateToolsOptions["workspace"];
}

export function resolveToolOptions(options: CreateToolsOptions): ResolvedToolOptions {
  const store = new WorkspaceFileStore(options.workspace);
  return {
    read: { store, ...options.read },
    write: { store, ...options.write },
    edit: { store, ...options.edit },
    delete: { store },
    exec:
      options.shell === undefined
        ? undefined
        : { workspace: options.workspace as ExecWorkspaceLike, ...options.shell },
    publish: options.assets !== false && options.workspace.assets !== undefined,
    readonly: options.readonly === true,
    workspace: options.workspace,
  };
}
