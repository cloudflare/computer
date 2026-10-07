import { type Tool, tool } from "ai";
import type { z } from "zod";
import {
  defineExec,
  type ExecInput,
  type ExecToolOptions,
  type ExecToolOutput,
} from "../common/exec.js";
import {
  type DeleteToolOptions,
  deleteDescription,
  deleteFromStore,
  deleteInputSchema,
} from "../common/fs/delete.js";
import {
  type EditToolOptions,
  editDescription,
  editInputSchema,
  editInStore,
} from "../common/fs/edit.js";
import {
  type FindToolOptions,
  findDescription,
  findInputSchema,
  findInWorkspace,
} from "../common/fs/find.js";
import {
  type GrepToolOptions,
  grepDescription,
  grepInputSchema,
  grepInWorkspace,
} from "../common/fs/grep.js";
import {
  type ListToolOptions,
  listDescription,
  listInputSchema,
  listWorkspace,
} from "../common/fs/list.js";
import {
  createReadExecutor,
  type ReadInput,
  type ReadToolOptions,
  type ReadToolResult,
  readDescription,
  readInputSchema,
  readModelOutput,
} from "../common/fs/read.js";
import {
  type WriteToolOptions,
  writeDescription,
  writeInputSchema,
  writeToStore,
} from "../common/fs/write.js";
import {
  createPublishExecutor,
  type PublishToolOptions,
  publishDescription,
  publishInputSchema,
} from "../common/publish.js";
import { toAISDKOutput } from "./output.js";

export function createReadTool(options: ReadToolOptions): Tool<z.infer<typeof readInputSchema>> {
  const toModelOutput = readModelOutput(options);
  return tool({
    description: readDescription(options),
    inputSchema: readInputSchema,
    execute: createReadExecutor(options),
    toModelOutput: ({ input, output }: { input: unknown; output: unknown }) =>
      toAISDKOutput(toModelOutput({ input: input as ReadInput, output: output as ReadToolResult })),
  });
}

export function createWriteTool(options: WriteToolOptions): Tool<z.infer<typeof writeInputSchema>> {
  return tool({
    description: writeDescription,
    inputSchema: writeInputSchema,
    execute: (input) => writeToStore(options, input),
  });
}

export function createEditTool(options: EditToolOptions): Tool<z.infer<typeof editInputSchema>> {
  return tool({
    description: editDescription,
    inputSchema: editInputSchema,
    execute: (rawInput) => editInStore(options, rawInput),
  });
}

export function createDeleteTool(
  options: DeleteToolOptions,
): Tool<z.infer<typeof deleteInputSchema>> {
  return tool({
    description: deleteDescription,
    inputSchema: deleteInputSchema,
    execute: (input) => deleteFromStore(options, input),
  });
}

export function createListTool(options: ListToolOptions): Tool<z.infer<typeof listInputSchema>> {
  return tool({
    description: listDescription,
    inputSchema: listInputSchema,
    execute: (input) => listWorkspace(options.workspace, input),
  });
}

export function createFindTool(options: FindToolOptions): Tool<z.infer<typeof findInputSchema>> {
  return tool({
    description: findDescription,
    inputSchema: findInputSchema,
    execute: (input) => findInWorkspace(options.workspace, input),
  });
}

export function createGrepTool(options: GrepToolOptions): Tool<z.infer<typeof grepInputSchema>> {
  return tool({
    description: grepDescription,
    inputSchema: grepInputSchema,
    execute: (input) => grepInWorkspace(options.workspace, input),
  });
}

export function createExecTool(options: ExecToolOptions): Tool<ExecInput, ExecToolOutput> {
  const exec = defineExec(options);
  return tool({
    description: exec.description,
    inputSchema: exec.inputSchema,
    execute: (input, { abortSignal }) => exec.execute(input, { abortSignal }),
  });
}

export function createPublishTool(
  options: PublishToolOptions,
): Tool<z.infer<typeof publishInputSchema>> {
  const execute = createPublishExecutor(options.workspace);
  return tool({
    description: publishDescription,
    inputSchema: publishInputSchema,
    execute: (input) => execute(input),
  });
}
