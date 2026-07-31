import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import type { WorkspaceClient } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";

/** Create the one-tool Code Mode MCP server for a Computer workspace. */
export async function createComputerMCPServer(workspace: WorkspaceClient, loader: WorkerLoader) {
  const computer = new McpServer({ name: "computer", version: "1.0.0" });
  const tools = createAITools({
    workspace,
    assets: false,
    shell: {
      backends: {
        "worker-shell": {
          description:
            "just-bash in an isolated Dynamic Worker. Starts quickly, " +
            "does not boot a container, and has no ambient outbound network. " +
            "Use it for common shell commands, quick file inspection, and " +
            "text transformations. Its built-in git command supports clone, " +
            "status, diff, and log; clone accepts HTTPS URLs through the " +
            "durable workspace. Prefer the dedicated read, write, and edit " +
            "tools for file operations. Cannot run npm, Node.js, Python, " +
            "package managers, or arbitrary native binaries.",
        },
        "container-shell": {
          description:
            "Full Debian Linux in a Cloudflare Container with Node.js, npm, " +
            "git, package management, native binaries, and outbound network. " +
            "Use it for dependency installation, builds, tests, or commands " +
            "that worker-shell cannot run. Cold starts more slowly because " +
            "the container must boot; prefer worker-shell for simple tasks.",
        },
      },
      defaultBackend: "worker-shell",
    },
  });

  for (const [name, tool] of Object.entries(tools)) {
    registerComputerTool(computer, name, tool);
  }

  return codeMcpServer({
    server: computer,
    executor: new DynamicWorkerExecutor({ loader, globalOutbound: null }),
  });
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
        const execution = await execute(args, {
          toolCallId: `mcp:${name}`,
          messages: [],
          abortSignal: context.signal,
          context: undefined,
        });
        const value = await finalToolValue(execution);
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

async function finalToolValue(execution: unknown): Promise<unknown> {
  if (!isAsyncIterable(execution)) return execution;
  let finalValue: unknown;
  for await (const value of execution) finalValue = value;
  return finalValue;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}
