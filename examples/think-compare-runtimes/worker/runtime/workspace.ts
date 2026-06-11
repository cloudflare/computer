import type { RuntimeCommandRunner, RuntimeExecOptions, RuntimeExecResult } from "./exec-tools";
import type { RuntimeFileStore } from "./file-tools";
import type { FixtureRuntime } from "./seed";

interface WorkspaceFixtureTarget {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeFile(path: string, contents: string): Promise<void>;
  };
}

interface WorkspaceFileStoreTarget {
  fs: {
    readFile(path: string, encoding: "utf8"): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
  };
}

interface WorkspaceCommandTarget {
  ready(backend?: string): Promise<void>;
  shell: {
    exec(
      command: string,
      options: { backend?: string; cwd?: string; encoding: "utf8"; timeoutMs?: number },
    ): Promise<{
      result(): Promise<RuntimeExecResult>;
    }>;
  };
}

export function createWorkspaceFixtureRuntime(workspace: WorkspaceFixtureTarget): FixtureRuntime {
  return {
    mkdir(path) {
      return workspace.fs.mkdir(path, { recursive: true });
    },
    writeFile(path, contents) {
      return workspace.fs.writeFile(path, contents);
    },
  };
}

export function createWorkspaceFileStore(workspace: WorkspaceFileStoreTarget): RuntimeFileStore {
  return {
    readFile(path) {
      return workspace.fs.readFile(path, "utf8");
    },
    writeFile(path, contents) {
      return workspace.fs.writeFile(path, contents);
    },
  };
}

export function createWorkspaceCommandRunner(
  workspace: WorkspaceCommandTarget,
): RuntimeCommandRunner {
  return {
    async exec(command, options) {
      const backend = workspaceBackendForCommand(command);
      await workspace.ready(backend);
      const handle = await workspace.shell.exec(command, toWorkspaceExecOptions(options, backend));
      const { exitCode, stdout, stderr } = await handle.result();
      return { exitCode, stdout, stderr, executionTarget: workspaceExecutionTarget(backend) };
    },
  };
}

function toWorkspaceExecOptions(
  options: RuntimeExecOptions | undefined,
  backend: string,
): {
  backend: string;
  cwd?: string;
  encoding: "utf8";
  timeoutMs?: number;
} {
  return {
    backend,
    cwd: options?.cwd,
    encoding: "utf8",
    timeoutMs: options?.timeoutMs,
  };
}

function workspaceBackendForCommand(command: string): "container" | "shell" {
  return /(^|\s)(npm|node|npx|pnpm|yarn|vitest|tsc)(\s|$)/.test(command) ? "container" : "shell";
}

function workspaceExecutionTarget(backend: "container" | "shell") {
  return backend === "shell" ? "worker-shell" : "workspace-container";
}
