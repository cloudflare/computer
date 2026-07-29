import { tool } from "ai";
import { z } from "zod";

export interface ListWorkspaceLike {
  fs: {
    readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  };
}

export interface ListToolOptions {
  workspace: ListWorkspaceLike;
}

const inputSchema = z.object({
  path: z.string().describe("Absolute directory path to list, e.g. /workspace/src."),
});

export function createListTool(options: ListToolOptions) {
  return tool({
    description:
      "List entries in a workspace directory. Returns each entry name and whether it is a file or directory.",
    inputSchema,
    execute: async ({ path }) => {
      try {
        const entries = await options.workspace.fs.readdir(path);
        return {
          path,
          entries: entries.map((entry) => ({
            name: entry.name,
            isFile: entry.isFile,
            isDirectory: entry.isDirectory,
          })),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
