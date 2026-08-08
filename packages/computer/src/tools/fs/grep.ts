import { type Tool, tool } from "ai";
import { z } from "zod";

interface GrepContextLine {
  line: number;
  text: string;
  isMatch: boolean;
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
  context?: GrepContextLine[];
}

interface GrepOptions {
  fixedString?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  limit?: number;
  offset?: number;
  include?: string;
}

export interface GrepWorkspaceLike {
  fs: {
    grep(pattern: string, path: string, options?: GrepOptions): Promise<GrepMatch[]>;
  };
}

export interface GrepToolOptions {
  workspace: GrepWorkspaceLike;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const inputSchema = z.object({
  path: z.string().default("/workspace").describe("Absolute file or directory to search."),
  query: z.string().describe("Regular expression or fixed string to search for."),
  include: z
    .string()
    .optional()
    .describe('Glob relative to path that limits searched files, for example "**/*.ts".'),
  fixedString: z.boolean().optional().describe("Treat query as plain text instead of a regex."),
  caseSensitive: z.boolean().optional().describe("Match letter case. Defaults to false."),
  contextLines: z.number().int().min(0).max(10).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export function createGrepTool(options: GrepToolOptions): Tool<z.infer<typeof inputSchema>> {
  return tool({
    description:
      "Search workspace text with a regular expression or fixed string. Results include paths and line numbers and can include surrounding lines.",
    inputSchema,
    execute: async ({
      path,
      query,
      include,
      fixedString,
      caseSensitive,
      contextLines,
      limit,
      offset,
    }) => {
      try {
        const pageSize = limit ?? DEFAULT_LIMIT;
        const pageOffset = offset ?? 0;
        const searchOptions = {
          fixedString: fixedString ?? false,
          caseSensitive: caseSensitive ?? false,
          contextLines: contextLines ?? 0,
        };
        const matches = await options.workspace.fs.grep(query, path, {
          ...searchOptions,
          include,
          limit: pageSize + 1,
          offset: pageOffset,
        });
        const truncated = matches.length > pageSize;
        const page = truncated ? matches.slice(0, pageSize) : matches;
        const result: {
          path: string;
          query: string;
          count: number;
          matches: GrepMatch[];
          nextOffset?: number;
        } = { path, query, count: page.length, matches: page };
        if (truncated) result.nextOffset = pageOffset + pageSize;
        return result;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
