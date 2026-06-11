import { z } from "zod";
import type { RunEvent, RuntimeId } from "../../shared/events";
import type { RunEventInput } from "../run-events";
import type { RuntimeAdapter } from "../runtime/adapter";
import { createRuntimeToolDescriptions } from "./prompts";

type RuntimeThinkToolName = "read" | "write" | "edit" | "exec";

type RuntimeThinkTool = {
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
};

type RuntimeThinkToolSet = Record<RuntimeThinkToolName, RuntimeThinkTool>;

const readInputSchema = z.object({
  path: z.string().describe("Absolute path under /workspace/repo to read."),
});

const writeInputSchema = z.object({
  path: z.string().describe("Absolute path under /workspace/repo to create or overwrite."),
  contents: z.string().describe("Complete file contents to write. This replaces the whole file."),
});

const editInputSchema = z.object({
  path: z.string().describe("Absolute path under /workspace/repo to edit."),
  edits: z
    .array(
      z.object({
        oldText: z
          .string()
          .describe("Exact text that appears once in the current file, including whitespace."),
        newText: z.string().describe("Replacement text."),
      }),
    )
    .min(1)
    .describe("Exact replacements to apply."),
});

const execInputSchema = z.object({
  command: z.string().describe("Shell command to run."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the command. Use /workspace/repo for project commands."),
  timeoutMs: z.number().int().positive().optional().describe("Command timeout in milliseconds."),
});

export interface RuntimeThinkToolRecorder {
  record(input: RunEventInput): RunEvent | Promise<RunEvent>;
}

export interface RuntimeThinkToolsOptions {
  adapter: RuntimeAdapter;
  recorder: RuntimeThinkToolRecorder;
}

export function createRuntimeThinkTools({
  adapter,
  recorder,
}: RuntimeThinkToolsOptions): RuntimeThinkToolSet {
  const runtime = adapter.runtime;
  const descriptions = createRuntimeToolDescriptions(runtime);

  return {
    read: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "read",
      description: descriptions.read,
      inputSchema: readInputSchema,
      execute: async (input) => {
        const { path } = readInputSchema.parse(input);
        return { path, content: await adapter.files.read(path) };
      },
    }),
    write: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "write",
      description: descriptions.write,
      inputSchema: writeInputSchema,
      execute: async (input) => {
        const { path, contents } = writeInputSchema.parse(input);
        await adapter.files.write(path, contents);
        return { path, bytesWritten: byteLength(contents) };
      },
    }),
    edit: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "edit",
      description: descriptions.edit,
      inputSchema: editInputSchema,
      execute: async (input) => {
        const { path, edits } = editInputSchema.parse(input);
        await adapter.files.edit(path, edits);
        return { path, editsApplied: edits.length };
      },
    }),
    exec: createRuntimeThinkTool({
      runtime,
      recorder,
      name: "exec",
      description: descriptions.exec,
      inputSchema: execInputSchema,
      execute: async (input) => {
        const { command, cwd, timeoutMs } = execInputSchema.parse(input);
        const result = await adapter.exec(command, { cwd, timeoutMs });
        return { command, cwd: cwd ?? null, ...result };
      },
    }),
  };
}

export async function executeRuntimeThinkTool(
  tools: RuntimeThinkToolSet,
  name: RuntimeThinkToolName,
  input: unknown,
): Promise<unknown> {
  return tools[name].execute(input);
}

interface CreateRuntimeThinkToolOptions {
  runtime: RuntimeId;
  recorder: RuntimeThinkToolRecorder;
  name: RuntimeThinkToolName;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

function createRuntimeThinkTool({
  runtime,
  recorder,
  name,
  description,
  inputSchema,
  execute,
}: CreateRuntimeThinkToolOptions): RuntimeThinkTool {
  return {
    description,
    inputSchema,
    async execute(input) {
      await recorder.record({
        runtime,
        kind: "agent_tool_call",
        title: `Think requested ${name}`,
        detail: stringifyForEvent(input),
      });

      try {
        const result = await execute(input);
        await recorder.record({
          runtime,
          kind: "agent_tool_result",
          title: `Think ${name} result`,
          detail: stringifyForEvent(result),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recorder.record({
          runtime,
          kind: "agent_tool_error",
          title: `Think ${name} error`,
          detail: message,
        });
        return { error: message };
      }
    },
  };
}

function stringifyForEvent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}
