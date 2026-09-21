/**
 * The options every provider's tool set accepts, and the gating rules
 * that decide which tools exist for a given Workspace.
 *
 * This is deliberately not a tool abstraction. Each provider declares
 * its own tools with its own schemas and descriptions; what lives here
 * is the part that is genuinely not provider-specific — which options a
 * caller passes, and which tools those options select. Keeping it in
 * one place is what stops `readonly` meaning one thing under the AI SDK
 * and another under pi.
 */

import type { ExecToolOptions, ExecWorkspaceLike } from "./exec.js";
import type { EditToolOptions } from "./fs/edit.js";
import type { ReadToolOptions } from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import type { WriteToolOptions } from "./fs/write.js";
import type { PublishWorkspaceLike } from "./publish.js";

/**
 * Options for the workspace tool set.
 *
 * Accepted by every provider entrypoint so the same knobs and defaults
 * apply whichever library an agent is built on.
 */
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

/**
 * The options resolved against one Workspace.
 *
 * A provider reads this to decide which tools to declare and hands the
 * per-tool option bundles to the executors in `./fs` and `./exec.js`.
 * Resolving once means the file store is constructed once and the
 * inclusion rules are stated once.
 */
export interface ResolvedToolOptions {
  read: ReadToolOptions;
  write: WriteToolOptions;
  edit: EditToolOptions;
  delete: { store: WorkspaceFileStore };
  /** Present only when command execution was requested. */
  exec?: ExecToolOptions;
  /** True when the workspace has assets configured and they are wanted. */
  publish: boolean;
  /** True when the mutating tools should be omitted. */
  readonly: boolean;
  workspace: CreateToolsOptions["workspace"];
}

/** Resolve the shared options against a Workspace. */
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
