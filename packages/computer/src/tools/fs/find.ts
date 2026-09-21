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
      options?: { limit?: number; offset?: number; exclude?: string[] },
    ): Promise<FoundEntry[]>;
  };
}

export interface FindToolOptions {
  workspace: FindWorkspaceLike;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export const findInputSchema = z.object({
  path: z.string().default("/workspace").describe("Absolute directory to search."),
  pattern: z
    .string()
    .describe('Glob pattern relative to path, for example "**/*.ts" or "src/?.js".'),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      'Glob patterns to leave out, for example ["node_modules/**", "**/.git/**"]. An excluded directory is skipped along with everything below it.',
    ),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export const findDescription =
  "Find files and directories matching a glob. * stays within one path segment, ** crosses directories, and ? matches one character.";

export interface FindInput {
  path?: string;
  pattern: string;
  exclude?: string[];
  limit?: number;
  offset?: number;
}

export type FindResult =
  | {
      path: string;
      pattern: string;
      count: number;
      entries: FoundEntry[];
      nextOffset?: number;
    }
  | { error: string };

/**
 * Page glob matches under a directory.
 *
 * `path` carries a schema default, but an executor can also be called
 * directly by an SDK that does not apply Zod defaults, so the root
 * fallback is repeated here.
 */
export async function findInWorkspace(
  workspace: FindWorkspaceLike,
  { path, pattern, exclude, limit, offset }: FindInput,
): Promise<FindResult> {
  const directory = path ?? "/workspace";
  try {
    const pageSize = limit ?? DEFAULT_LIMIT;
    const pageOffset = offset ?? 0;
    const matches = await workspace.fs.find(directory, pattern, {
      limit: pageSize + 1,
      offset: pageOffset,
      exclude,
    });
    const truncated = matches.length > pageSize;
    const entries = truncated ? matches.slice(0, pageSize) : matches;
    const result: {
      path: string;
      pattern: string;
      count: number;
      entries: FoundEntry[];
      nextOffset?: number;
    } = { path: directory, pattern, count: entries.length, entries };
    if (truncated) result.nextOffset = pageOffset + pageSize;
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function createFindTool(options: FindToolOptions): Tool<z.infer<typeof findInputSchema>> {
  return tool({
    description: findDescription,
    inputSchema: findInputSchema,
    execute: (input) => findInWorkspace(options.workspace, input),
  });
}
