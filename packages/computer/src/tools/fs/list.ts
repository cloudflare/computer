import { type Tool, tool } from "ai";
import { z } from "zod";

export interface ListWorkspaceLike {
  fs: {
    readdir(
      path: string,
      options?: { limit?: number; offset?: number },
    ): Promise<
      Array<{
        name: string;
        size: number;
        mtime: number;
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
      }>
    >;
  };
}

export interface ListToolOptions {
  workspace: ListWorkspaceLike;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const inputSchema = z.object({
  path: z.string().describe("Absolute directory path to list, e.g. /workspace/src."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum entries to return. Defaults to ${DEFAULT_LIMIT}.`),
  offset: z.number().int().min(0).optional().describe("Number of entries to skip in name order."),
});

export function createListTool(options: ListToolOptions): Tool<z.infer<typeof inputSchema>> {
  return tool({
    description: `List entries in a workspace directory with file sizes and modification times. The result defaults to ${DEFAULT_LIMIT} entries; use limit and offset to page through large directories.`,
    inputSchema,
    execute: async ({ path, limit, offset }) => {
      try {
        const pageSize = limit ?? DEFAULT_LIMIT;
        const pageOffset = offset ?? 0;
        const entries = await options.workspace.fs.readdir(path, {
          limit: pageSize + 1,
          offset: pageOffset,
        });
        const truncated = entries.length > pageSize;
        const page = (truncated ? entries.slice(0, pageSize) : entries).map((entry) => ({
          name: entry.name,
          size: entry.size,
          mtime: entry.mtime,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          isSymbolicLink: entry.isSymbolicLink,
        }));
        const result: {
          path: string;
          count: number;
          entries: typeof page;
          nextOffset?: number;
        } = {
          path,
          count: page.length,
          entries: page,
        };
        if (truncated) result.nextOffset = pageOffset + pageSize;
        return result;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
