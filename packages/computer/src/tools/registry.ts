/**
 * The one place the workspace tool set is assembled.
 *
 * `createToolSpecs` decides which tools exist for a given Workspace and
 * set of options, and wires each to the executor that already backs the
 * AI SDK tools. Every SDK entrypoint calls this, so `readonly`, `shell`,
 * and `assets` gating, tool names, descriptions, schemas, and caps are
 * defined once rather than once per SDK.
 */

import type { AssetsClient } from "../assets/index.js";
import {
  createExecExecutor,
  type ExecInput,
  type ExecToolOptions,
  type ExecWorkspaceLike,
  execDescription,
  execInputSchema,
} from "./exec.js";
import {
  type DeleteInput,
  deleteDescription,
  deleteFromStore,
  deleteInputSchema,
} from "./fs/delete.js";
import {
  type EditInput,
  type EditToolOptions,
  editDescription,
  editInputSchema,
  editInStore,
} from "./fs/edit.js";
import {
  type FindInput,
  type FindWorkspaceLike,
  findDescription,
  findInputSchema,
  findInWorkspace,
} from "./fs/find.js";
import {
  type GrepInput,
  type GrepWorkspaceLike,
  grepDescription,
  grepInputSchema,
  grepInWorkspace,
} from "./fs/grep.js";
import {
  type ListInput,
  type ListWorkspaceLike,
  listDescription,
  listInputSchema,
  listWorkspace,
} from "./fs/list.js";
import {
  createReadExecutor,
  type ReadInput,
  type ReadToolOptions,
  readDescription,
  readInputSchema,
  readModelOutput,
} from "./fs/read.js";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store.js";
import {
  type WriteInput,
  type WriteToolOptions,
  writeDescription,
  writeInputSchema,
  writeToStore,
} from "./fs/write.js";
import {
  createPublishExecutor,
  type PublishInput,
  type PublishWorkspaceLike,
  publishDescription,
  publishInputSchema,
} from "./publish.js";
import { type AnyToolSpec, defineTool, type ToolSpec, type ToolSpecSet } from "./spec.js";

/**
 * Options for the workspace tool set.
 *
 * Shared by `createAITools`, `createPiTools`, and `createTanStackTools`
 * so the three SDKs expose the same knobs and defaults.
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
 * Build the SDK-neutral spec set for a Workspace.
 *
 * Read-only sets keep the four search and inspection tools. The mutating
 * tools, `exec`, and `publish` are added under the same conditions the
 * AI SDK entrypoint has always used.
 */
export function createToolSpecs(options: CreateToolsOptions): ToolSpecSet {
  const store = new WorkspaceFileStore(options.workspace);
  const readOptions: ReadToolOptions = { store, ...options.read };

  const specs: Record<string, AnyToolSpec> = {};
  const add = <I, O>(spec: ToolSpec<I, O>) => {
    specs[spec.name] = spec as unknown as AnyToolSpec;
  };

  const readExecutor = createReadExecutor(readOptions);
  add(
    defineTool({
      name: "read",
      description: readDescription(readOptions),
      inputSchema: readInputSchema,
      execute: (input: ReadInput) => readExecutor(input),
      toModelOutput: readModelOutput(readOptions),
    }),
  );

  const listWorkspaceLike = options.workspace as ListWorkspaceLike;
  add(
    defineTool({
      name: "ls",
      description: listDescription,
      inputSchema: listInputSchema,
      execute: (input: ListInput) => listWorkspace(listWorkspaceLike, input),
    }),
  );

  const findWorkspaceLike = options.workspace as FindWorkspaceLike;
  add(
    defineTool({
      name: "find",
      description: findDescription,
      inputSchema: findInputSchema,
      execute: (input: FindInput) => findInWorkspace(findWorkspaceLike, input),
    }),
  );

  const grepWorkspaceLike = options.workspace as GrepWorkspaceLike;
  add(
    defineTool({
      name: "grep",
      description: grepDescription,
      inputSchema: grepInputSchema,
      execute: (input: GrepInput) => grepInWorkspace(grepWorkspaceLike, input),
    }),
  );

  if (options.readonly === true) return specs;

  const writeOptions: WriteToolOptions = { store, ...options.write };
  add(
    defineTool({
      name: "write",
      description: writeDescription,
      inputSchema: writeInputSchema,
      execute: (input: WriteInput) => writeToStore(writeOptions, input),
    }),
  );

  const editOptions: EditToolOptions = { store, ...options.edit };
  add(
    defineTool({
      name: "edit",
      description: editDescription,
      inputSchema: editInputSchema,
      execute: (input: EditInput) => editInStore(editOptions, input),
    }),
  );

  add(
    defineTool({
      name: "delete",
      description: deleteDescription,
      inputSchema: deleteInputSchema,
      execute: (input: DeleteInput) => deleteFromStore({ store }, input),
    }),
  );

  if (options.shell !== undefined) {
    const execOptions: ExecToolOptions = {
      workspace: options.workspace as ExecWorkspaceLike,
      ...options.shell,
    };
    const executor = createExecExecutor(execOptions);
    add(
      defineTool({
        name: "exec",
        description: execDescription(execOptions),
        inputSchema: execInputSchema(execOptions),
        execute: (input: ExecInput, context) => executor(input, context),
      }),
    );
  }

  if (options.assets !== false && options.workspace.assets !== undefined) {
    const publishWorkspace = options.workspace as PublishWorkspaceLike;
    const executor = createPublishExecutor(publishWorkspace);
    add(
      defineTool({
        name: "publish",
        description: publishDescription,
        inputSchema: publishInputSchema,
        execute: (input: PublishInput) => executor(input),
      }),
    );
  }

  return specs;
}

export type { AssetsClient };
