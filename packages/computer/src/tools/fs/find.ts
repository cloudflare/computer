import { type Tool, tool } from "ai";
import { z } from "zod";

interface FoundEntry {
  path: string;
  type: "file" | "dir";
}

export interface FindWorkspaceLike {
  fs: {
    find(
      directory: string,
      pattern?: string,
      options?: { limit?: number; offset?: number },
    ): Promise<FoundEntry[]>;
  };
}

export interface FindToolOptions {
  workspace: FindWorkspaceLike;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const inputSchema = z.object({
  path: z.string().default("/workspace").describe("Absolute directory to search."),
  pattern: z
    .string()
    .describe('Glob pattern relative to path, for example "**/*.ts" or "src/?.js".'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export function createFindTool(options: FindToolOptions): Tool<z.infer<typeof inputSchema>> {
  return tool({
    description:
      "Find files and directories matching a glob. * stays within one path segment, ** crosses directories, and ? matches one character.",
    inputSchema,
    execute: async ({ path, pattern, limit, offset }) => {
      try {
        const pageSize = limit ?? DEFAULT_LIMIT;
        const pageOffset = offset ?? 0;
        const matches = await options.workspace.fs.find(path, pattern, {
          limit: pageSize + 1,
          offset: pageOffset,
        });
        const truncated = matches.length > pageSize;
        const entries = truncated ? matches.slice(0, pageSize) : matches;
        const result: {
          path: string;
          pattern: string;
          count: number;
          entries: FoundEntry[];
          nextOffset?: number;
        } = { path, pattern, count: entries.length, entries };
        if (truncated) result.nextOffset = pageOffset + pageSize;
        return result;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
