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

const workerShellCommands = new Set([
  "cat",
  "cd",
  "echo",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "sed",
  "tail",
  "test",
  "true",
  "wc",
]);

const containerCommands = new Set(["node", "npm", "npx", "pnpm", "tsc", "vitest", "yarn"]);

function workspaceBackendForCommand(command: string): "container" | "shell" {
  const executables = shellExecutables(command);
  if (executables.length === 0) return "shell";
  return executables.every((executable) => workerShellCommands.has(executable))
    ? "shell"
    : "container";
}

function shellExecutables(command: string): string[] {
  return shellSegments(command).flatMap((segment) => {
    const executable = firstExecutable(segment);
    return executable ? [executable] : [];
  });
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = "";
      if ((char === "|" || char === "&") && command[index + 1] === char) index++;
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);
  return segments;
}

function firstExecutable(segment: string): string | null {
  for (const token of shellWords(segment)) {
    if (isEnvironmentAssignment(token)) continue;
    if (containerCommands.has(token)) return token;
    if (token.startsWith("./") || token.startsWith("../") || token.startsWith("/")) return token;
    return token;
  }
  return null;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function workspaceExecutionTarget(backend: "container" | "shell") {
  return backend === "shell" ? "worker-shell" : "computer-container";
}
