import type {
  ExecBackends,
  ExecDetachOptions,
  ExecMetadata,
  ExecToolOptions,
  ExecWorkspaceLike,
} from "./exec";
import { confineWorkspace } from "./fs/confine";
import type { EditToolOptions } from "./fs/edit";
import type { ReadToolOptions } from "./fs/read";
import { type WorkspaceLike as FileWorkspaceLike, WorkspaceFileStore } from "./fs/store";
import type { WriteToolOptions } from "./fs/write";
import type { PublishWorkspaceLike } from "./publish";

/** Options every tool set takes: `createAITools`, `createPiTools`, and `createTanStackTools`. */
export interface CreateToolsOptions {
  workspace: FileWorkspaceLike & Partial<ExecWorkspaceLike> & Partial<PublishWorkspaceLike>;
  /**
   * Omit `write`, `edit`, `delete`, and `publish`, and offer `exec` only
   * on backends that can't change the Workspace, such as a
   * `CodemodeBackend` with `access: "read"`.
   */
  readonly?: boolean;
  root?: string;
  /** Set `false` to omit `publish` even when assets are configured. */
  assets?: boolean;
  read?: Omit<ReadToolOptions, "store">;
  write?: Omit<WriteToolOptions, "store">;
  edit?: Omit<EditToolOptions, "store">;
  /**
   * Options for the `exec` tool. Omit `exec` or its `backends` to offer
   * every backend the Workspace has; `{ backends: {} }` means no exec
   * tool. `exec: {}` and keys other than `backends`, `output`,
   * `metadata` and `detach`, such as a backend map from before `exec.backends`,
   * throw.
   */
  exec?: ExecToolSetOptions;
  /**
   * @deprecated Use `exec`. `{ backends }` becomes `exec: { backends }`
   * and `maxBytes` and `maxLines` move to `exec: { output }`;
   * `defaultBackend` is ignored, because the model names a backend
   * whenever there is a choice.
   */
  shell?: LegacyShellOptions;
}

/** The `exec` options every tool set takes. */
export interface ExecToolSetOptions {
  /**
   * The backends `exec` may run on, keyed by id, each with an optional
   * description for the model. Omit to offer every backend the
   * Workspace has; `{}` means no exec tool.
   */
  backends?: ExecBackends;
  /** How much of each `exec` stream the model sees. */
  output?: Pick<ExecToolOptions, "maxBytes" | "maxLines">;
  /**
   * The `metadata` each `exec` run starts with, or a function that picks
   * it from the tool call's id. Host modules read it; the model never
   * sees it.
   */
  metadata?: ExecMetadata;
  /**
   * Return before a run ends and leave it running, once it waits for an
   * answer or, with `afterMs`, has gone on that long. Its exit goes to
   * the backend's `onDetachedExit`. Experimental.
   */
  detach?: ExecDetachOptions;
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
  /**
   * Absent when the Workspace has no runtime or no backend is selected,
   * which for a read-only set means none that only reads.
   */
  exec?: ExecToolOptions;
  publish: boolean;
  readonly: boolean;
  workspace: CreateToolsOptions["workspace"];
}

/** Resolve the options into what each tool needs, so every tool set offers the same tools. */
export function resolveToolOptions(options: CreateToolsOptions): ResolvedToolOptions {
  checkExec(options.exec);
  const workspace =
    options.root === undefined
      ? options.workspace
      : confineWorkspace(options.workspace, options.root);
  const store = new WorkspaceFileStore(workspace);
  const readonly = options.readonly === true;
  return {
    read: { store, ...options.read },
    write: { store, ...options.write },
    edit: { store, ...options.edit },
    delete: { store },
    exec: execOptions(options, readonly),
    publish: !readonly && options.assets !== false && workspace.assets !== undefined,
    readonly,
    workspace,
  };
}

const EXEC_KEYS = new Set(["backends", "output", "metadata", "detach"]);

// Reject the shapes `exec` had before it took `{ backends, output,
// metadata }`, rather than offering every backend for them.
function checkExec(exec: ExecToolSetOptions | undefined): void {
  if (exec === undefined) return;
  const keys = Object.keys(exec);
  if (keys.some((key) => !EXEC_KEYS.has(key))) {
    throw new TypeError(
      "exec takes `{ backends, output, metadata, detach }`; move backend options under `exec.backends`",
    );
  }
  if (keys.length === 0) {
    throw new TypeError(
      "`exec: {}` no longer turns exec off; pass `exec: { backends: {} }` for no exec tool, or leave `exec` out for every backend",
    );
  }
}

// Turn `exec`, or the deprecated `shell`, into exec tool options.
function execOptions(options: CreateToolsOptions, readonly: boolean): ExecToolOptions | undefined {
  const runtime = options.workspace.runtime;
  if (runtime === undefined) return undefined;
  const selected = selectExec(options, runtime);
  const backends = readonly ? readOnlyBackends(selected.backends, runtime) : selected.backends;
  if (Object.keys(backends).length === 0) return undefined;
  const { output, metadata } = options.exec ?? {};
  // A read-only set keeps `detach` only if a backend it kept can
  // detach, as it would have left out exec, detach and all, before.
  const detach = readonly && !canDetach(backends, runtime) ? undefined : options.exec?.detach;
  return {
    workspace: { runtime },
    ...selected,
    backends,
    ...(output?.maxBytes === undefined ? {} : { maxBytes: output.maxBytes }),
    ...(output?.maxLines === undefined ? {} : { maxLines: output.maxLines }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(detach === undefined ? {} : { detach }),
    // The runtime writes saved output from the host, past the backend's
    // read-only guard, so a read-only set saves none.
    ...(readonly ? { saveOutput: false } : {}),
  };
}

function canDetach(backends: ExecBackends, runtime: ExecWorkspaceLike["runtime"]): boolean {
  return (runtime.backends?.() ?? []).some(
    (info) => info.detachable === true && info.id in backends,
  );
}

// A read-only set's exec runs only on backends that can't change the
// Workspace. The backend enforces it, so exec can't write either.
function readOnlyBackends(
  backends: ExecBackends,
  runtime: ExecWorkspaceLike["runtime"],
): ExecBackends {
  const reading = new Set(
    (runtime.backends?.() ?? []).filter((info) => info.access === "read").map((info) => info.id),
  );
  return Object.fromEntries(Object.entries(backends).filter(([id]) => reading.has(id)));
}

function selectExec(
  options: CreateToolsOptions,
  runtime: ExecWorkspaceLike["runtime"],
): Omit<ExecToolOptions, "workspace"> & { backends: ExecBackends } {
  // `exec` wins over the deprecated `shell`, so `exec: { backends: {} }`
  // always means no exec tool.
  const exec = options.exec;
  if (exec?.backends !== undefined) return { backends: exec.backends };
  if (exec === undefined && options.shell !== undefined) {
    const { backends, defaultBackend: _ignored, ...limits } = options.shell;
    return { ...limits, backends };
  }
  return { backends: Object.fromEntries((runtime.backends?.() ?? []).map(({ id }) => [id, {}])) };
}
