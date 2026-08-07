import type { WorkspaceClient } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";

const EXEC_TIMEOUT_MS = 30_000;
const TOOL_SETTLEMENT_TIMEOUT_MS = EXEC_TIMEOUT_MS + 1_000;

/** Build the native Computer tool server that Codemode wraps. */
export function createComputerMcpServer(workspace: WorkspaceClient) {
  const server = new McpServer({ name: "computer", version: "1.0.0" });
  const tools = createAITools({
    workspace: {
      fs: workspace.fs,
      runtime: {
        exec(command, options) {
          return workspace.runtime.exec(command, {
            ...options,
            timeoutMs: EXEC_TIMEOUT_MS,
          });
        },
      },
    },
    assets: false,
    shell: {
      backends: {
        "worker-shell": {
          description: "A fast, isolated shell over the durable Computer workspace.",
        },
      },
      defaultBackend: "worker-shell",
    },
  });

  for (const [name, tool] of Object.entries(tools)) {
    registerComputerTool(server, name, tool);
  }
  return server;
}

interface ToolCallContext {
  signal: AbortSignal;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type RegisterTool = (
  name: string,
  config: { description?: string; inputSchema: unknown },
  callback: (args: unknown, context: ToolCallContext) => Promise<ToolResult>,
) => unknown;

type ExecuteTool = (
  args: unknown,
  options: {
    toolCallId: string;
    messages: never[];
    abortSignal: AbortSignal;
    context: undefined;
  },
) => unknown | PromiseLike<unknown>;

function registerComputerTool(server: McpServer, name: string, tool: ToolSet[string]) {
  if (!tool.execute) throw new Error(`Computer tool ${name} is not executable.`);
  const execute = tool.execute as ExecuteTool;
  const registerTool = server.registerTool.bind(server) as RegisterTool;
  registerTool(
    name,
    {
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    },
    async (args, context) => {
      try {
        const value = await settle(
          () =>
            execute(args, {
              toolCallId: `mcp:${name}`,
              messages: [],
              abortSignal: context.signal,
              context: undefined,
            }),
          context.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(value) ?? "undefined" }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

function settle<T>(start: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Computer tool call cancelled."));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      complete();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Computer tool call timed out."))),
      TOOL_SETTLEMENT_TIMEOUT_MS,
    );
    const cancel = () => finish(() => reject(new Error("Computer tool call cancelled.")));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();

    if (!settled) {
      Promise.resolve()
        .then(start)
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
    }
  });
}
