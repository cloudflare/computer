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
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
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
  query: z.string().describe("Literal string or regular expression to search for."),
  include: z
    .string()
    .optional()
    .describe('Glob relative to path that limits searched files, for example "**/*.ts".'),
  regex: z.boolean().optional().describe("Interpret query as a regular expression."),
  ignoreCase: z.boolean().optional().describe("Ignore letter case."),
  context: z.number().int().min(0).max(10).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export function createGrepTool(options: GrepToolOptions): Tool<z.infer<typeof inputSchema>> {
  return tool({
    description:
      "Search workspace text with a literal string or regular expression. Results include paths and line numbers and can include surrounding lines.",
    inputSchema,
    execute: async ({ path, query, include, regex, ignoreCase, context, limit, offset }) => {
      try {
        const pageSize = limit ?? DEFAULT_LIMIT;
        const pageOffset = offset ?? 0;
        const searchOptions = {
          regex: regex ?? false,
          ignoreCase: ignoreCase ?? false,
          context: context ?? 0,
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
