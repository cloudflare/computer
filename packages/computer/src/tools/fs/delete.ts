import { type Tool, tool } from "ai";
import { z } from "zod";
import { withFileLock } from "./locks.js";
import type { MutableFileStore } from "./types.js";

export interface DeleteToolOptions {
  store: MutableFileStore;
}

export const deleteInputSchema = z.object({
  path: z.string().describe("Absolute path to the file or directory to delete."),
  recursive: z
    .boolean()
    .optional()
    .describe("Remove a directory and all of its contents. Defaults to false."),
});

/**
 * Shape of the result.
 *
 * A failure is an ordinary outcome for a filesystem tool, not a
 * violation, so the error branch belongs in the schema. An SDK that
 * validates a tool return against this would otherwise replace the
 * real reason with a schema complaint.
 */
export const deleteOutputSchema = z.union([
  z.object({ deleted: z.string() }),
  z.object({ error: z.string() }),
]);

export const deleteDescription =
  "Delete a file or directory. Set recursive to true to remove a non-empty directory.";

export interface DeleteInput {
  path: string;
  recursive?: boolean;
}

export function deleteFromStore(
  options: DeleteToolOptions,
  { path, recursive }: DeleteInput,
): Promise<{ deleted: string } | { error: string }> {
  return withFileLock(
    options.store,
    path,
    async () => {
      try {
        await options.store.remove(path, { recursive, force: true });
        return { deleted: path };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    { subtree: recursive === true },
  );
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
