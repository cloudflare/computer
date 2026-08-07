import { type Tool, tool } from "ai";
import { z } from "zod";
import { withFileLock } from "./locks.js";
import type { MutableFileStore } from "./types.js";

export interface DeleteToolOptions {
  store: MutableFileStore;
}

const inputSchema = z.object({
  path: z.string().describe("Absolute path to the file or directory to delete."),
  recursive: z
    .boolean()
    .optional()
    .describe("Remove a directory and all of its contents. Defaults to false."),
});

export function createDeleteTool(options: DeleteToolOptions): Tool<z.infer<typeof inputSchema>> {
  const { store } = options;
  return tool({
    description:
      "Delete a file or directory. Set recursive to true to remove a non-empty directory.",
    inputSchema,
    execute: async ({ path, recursive }) =>
      withFileLock(store, path, async () => {
        try {
          await store.remove(path, { recursive, force: true });
          return { deleted: path };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }),
  });
}
