import { tool } from "ai";
import { z } from "zod";

export interface ExecWorkspaceLike {
  shell: {
    exec(
      command: string,
      options: { cwd?: string; encoding: "utf8"; backend?: string },
    ): Promise<{
      result(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }>;
  };
}

export interface ExecBackendDescription {
  description: string;
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  backends: Record<string, ExecBackendDescription>;
  defaultBackend: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

export function createExecTool(options: ExecToolOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const backendIds = Object.keys(options.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(options.defaultBackend)) {
    throw new Error(
      `createExecTool: defaultBackend ${JSON.stringify(options.defaultBackend)} is not one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }

  const backendGuidance = backendIds
    .map((id) => `- ${JSON.stringify(id)}: ${options.backends[id].description}`)
    .join("\n");
  const description = [
    "Run a shell command in the workspace. The workspace exposes multiple backends, each with different capabilities.",
    "Pick the cheapest backend that can run the command; fall back to a heavier one only when the lighter backend's command set doesn't cover what you need.",
    "",
    "Backends:",
    backendGuidance,
    "",
    `Default backend: ${JSON.stringify(options.defaultBackend)}. Try this first for any command you're not sure about; if it fails with a "command not found" or a similar capability error, retry on a backend whose description covers the missing tool.`,
    "Use for builds, test runs, typechecks, formatters, and git plumbing. Prefer the dedicated read, write, and edit tools for file operations. Long output is truncated to keep tool replies small.",
  ].join("\n");

  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        "Which backend to run on. Omit to use the default",
        `(${JSON.stringify(options.defaultBackend)}). Set explicitly when the`,
        "default backend is not capable of running the command. If a command fails because the backend lacks that tool, retry on a backend whose description covers it.",
      ].join(" "),
    );

  return tool({
    description,
    inputSchema: z.object({
      command: z.string().describe("Shell command, e.g. 'npm test' or 'git diff HEAD'."),
      cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
      backend: backendSchema,
    }),
    execute: async ({ command, cwd, backend }) => {
      const selectedBackend = backend ?? options.defaultBackend;
      try {
        const handle = await options.workspace.shell.exec(command, {
          cwd,
          encoding: "utf8",
          backend: selectedBackend,
        });
        const result = await handle.result();
        return {
          command,
          cwd: cwd ?? null,
          backend: selectedBackend,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, maxBytes),
          stderr: truncate(result.stderr, maxBytes),
        };
      } catch (err) {
        return {
          command,
          cwd: cwd ?? null,
          backend: selectedBackend,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

const encoder = new TextEncoder();

function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  const totalBytes = encoder.encode(value).byteLength;
  if (totalBytes <= maxBytes) return value;

  let usedBytes = 0;
  let endOffset = 0;
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength;
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    endOffset += char.length;
  }

  return `${value.slice(0, endOffset)}\n\n[truncated, ${totalBytes - usedBytes} more bytes]`;
}
