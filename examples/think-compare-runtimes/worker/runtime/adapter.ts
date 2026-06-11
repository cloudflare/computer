import type { RuntimeId } from "../../shared/events";
import type { RunEventRecorderLike } from "../run-events";
import {
  createRuntimeExecTool,
  type RuntimeCommandRunner,
  type RuntimeExecTool,
} from "./exec-tools";
import { createRuntimeFileTools, type RuntimeFileStore, type RuntimeFileTools } from "./file-tools";
import { createSandboxCommandRunner, createSandboxFileStore } from "./sandbox";
import { createWorkspaceCommandRunner, createWorkspaceFileStore } from "./workspace";

export interface RuntimeAdapter {
  runtime: RuntimeId;
  files: RuntimeFileTools;
  exec: RuntimeExecTool;
}

type WorkspaceRuntimeAdapterOptions = {
  recorder: RunEventRecorderLike;
} & (
  | {
      workspace: Parameters<typeof createWorkspaceFileStore>[0] &
        Parameters<typeof createWorkspaceCommandRunner>[0];
      store?: never;
      runner?: never;
    }
  | { store: RuntimeFileStore; runner: RuntimeCommandRunner; workspace?: never }
);

type SandboxRuntimeAdapterOptions = {
  recorder: RunEventRecorderLike;
} & (
  | {
      sandbox: Parameters<typeof createSandboxFileStore>[0] &
        Parameters<typeof createSandboxCommandRunner>[0];
      store?: never;
      runner?: never;
    }
  | { store: RuntimeFileStore; runner: RuntimeCommandRunner; sandbox?: never }
);

export function createWorkspaceRuntimeAdapter(
  options: WorkspaceRuntimeAdapterOptions,
): RuntimeAdapter {
  const { recorder } = options;
  const runtime = "workspace";

  const store = options.store ?? createWorkspaceFileStore(options.workspace);
  const runner = options.runner ?? createWorkspaceCommandRunner(options.workspace);

  return {
    runtime,
    files: createRuntimeFileTools({
      runtime,
      recorder,
      store,
    }),
    exec: createRuntimeExecTool({
      runtime,
      recorder,
      runner,
    }),
  };
}

export function createSandboxRuntimeAdapter(options: SandboxRuntimeAdapterOptions): RuntimeAdapter {
  const { recorder } = options;
  const runtime = "sandbox";

  const store = options.store ?? createSandboxFileStore(options.sandbox);
  const runner = options.runner ?? createSandboxCommandRunner(options.sandbox);

  return {
    runtime,
    files: createRuntimeFileTools({
      runtime,
      recorder,
      store,
    }),
    exec: createRuntimeExecTool({
      runtime,
      recorder,
      runner,
    }),
  };
}
