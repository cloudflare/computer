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

export const listInputSchema = z.object({
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

export const listDescription = `List entries in a workspace directory with file sizes and modification times. The result defaults to ${DEFAULT_LIMIT} entries; use limit and offset to page through large directories.`;

export interface ListInput {
  path: string;
  limit?: number;
  offset?: number;
}

interface ListEntry {
  name: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export type ListResult =
  | { path: string; count: number; entries: ListEntry[]; nextOffset?: number }
  | { error: string };

/**
 * Page one directory.
 *
 * Reads one more entry than the page size to learn whether a further
 * page exists without a second call, then reports `nextOffset` when it
 * does.
 */
export async function listWorkspace(
  workspace: ListWorkspaceLike,
  { path, limit, offset }: ListInput,
): Promise<ListResult> {
  try {
    const pageSize = limit ?? DEFAULT_LIMIT;
    const pageOffset = offset ?? 0;
    const entries = await workspace.fs.readdir(path, {
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
}

export function createListTool(options: ListToolOptions): Tool<z.infer<typeof listInputSchema>> {
  return tool({
    description: listDescription,
    inputSchema: listInputSchema,
    execute: (input) => listWorkspace(options.workspace, input),
  });
}
