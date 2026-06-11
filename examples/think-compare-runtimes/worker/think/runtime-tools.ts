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

const projectRoot = "/workspace/repo";

const projectPathSchema = z.string().refine(isProjectPath, `Path must be under ${projectRoot}.`);

const readInputSchema = z.object({
  path: projectPathSchema.describe("Absolute path under /workspace/repo to read."),
});

const writeInputSchema = z.object({
  path: projectPathSchema.describe("Absolute path under /workspace/repo to create or overwrite."),
  contents: z.string().describe("Complete file contents to write. This replaces the whole file."),
});

const editInputSchema = z.object({
  path: projectPathSchema.describe("Absolute path under /workspace/repo to edit."),
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
  command: z.string().min(1).describe("Shell command to run."),
  cwd: projectPathSchema
    .optional()
    .describe("Working directory for the command. Defaults to /workspace/repo."),
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
        const { command, cwd: parsedCwd, timeoutMs } = execInputSchema.parse(input);
        const cwd = parsedCwd ?? projectRoot;
        const result = await adapter.exec(command, { cwd, timeoutMs });
        return { command, cwd, ...result };
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
        const message = formatToolError(error);
        await recorder.record({
          runtime,
          kind: "agent_tool_error",
          title: `Think ${name} error`,
          detail: stringifyErrorForEvent(inputSchema, input, message),
        });
        return { error: message };
      }
    },
  };
}

function isProjectPath(path: string): boolean {
  return path === projectRoot || path.startsWith(`${projectRoot}/`);
}

function formatToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function stringifyErrorForEvent(inputSchema: z.ZodType, input: unknown, error: string): string {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || typeof parsed.data !== "object" || parsed.data === null) return error;
  return stringifyForEvent({ ...(parsed.data as Record<string, unknown>), error });
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
