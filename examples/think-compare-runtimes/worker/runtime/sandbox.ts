import type { RuntimeCommandRunner, RuntimeExecOptions, RuntimeExecResult } from "./exec-tools";
import type { RuntimeFileStore } from "./file-tools";
import type { FixtureRuntime } from "./seed";

interface SandboxFixtureTarget {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
}

interface SandboxReadFileResult {
  content: string | Uint8Array;
}

interface SandboxFileStoreTarget {
  readFile(path: string): Promise<SandboxReadFileResult>;
  writeFile(path: string, contents: string): Promise<unknown>;
}

interface SandboxCommandTarget {
  exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<RuntimeExecResult>;
}

export function createSandboxFixtureRuntime(sandbox: SandboxFixtureTarget): FixtureRuntime {
  return {
    async mkdir(path) {
      await sandbox.mkdir(path, { recursive: true });
    },
    async writeFile(path, contents) {
      await sandbox.writeFile(path, contents);
    },
  };
}

export function createSandboxFileStore(sandbox: SandboxFileStoreTarget): RuntimeFileStore {
  return {
    async readFile(path) {
      const file = await sandbox.readFile(path);
      return typeof file.content === "string"
        ? file.content
        : new TextDecoder().decode(file.content);
    },
    async writeFile(path, contents) {
      await sandbox.writeFile(path, contents);
    },
  };
}

export function createSandboxCommandRunner(sandbox: SandboxCommandTarget): RuntimeCommandRunner {
  return {
    async exec(command, options) {
      const { exitCode, stdout, stderr } = await sandbox.exec(
        command,
        toSandboxExecOptions(options),
      );
      return { exitCode, stdout, stderr, executionTarget: "sandbox-container" };
    },
  };
}

function toSandboxExecOptions(options: RuntimeExecOptions | undefined): {
  cwd?: string;
  timeout?: number;
} {
  return {
    cwd: options?.cwd,
    timeout: options?.timeoutMs,
  };
}
