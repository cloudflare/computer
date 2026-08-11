import { type Tool, tool } from "ai";
import { z } from "zod";
import { withFileLock } from "./locks.js";
import type { FileStore } from "./types.js";

export interface WriteToolOptions {
  store: FileStore;
  /**
   * Reject writes whose UTF-8 byte length exceeds this cap. The model is
   * pointed at the edit tool instead. Default 2 MiB.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().describe("Absolute path, e.g. /workspace/main.zig"),
  content: z.string().describe("File content"),
});

export interface WriteInput {
  path: string;
  content: string;
}

export async function writeToStore(
  options: WriteToolOptions,
  { path, content }: WriteInput,
): Promise<{ path: string; bytesWritten: number } | { error: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > maxBytes) {
    return {
      error: `Content too large: ${bytes.length} bytes exceeds the ${maxBytes}-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.`,
    };
  }
  return withFileLock(options.store, path, async () => {
    try {
      // Preserve the existing file's mode when overwriting so executable
      // scripts don't silently lose its executable bits. For new files we
      // let the store apply its own default.
      const existing = await options.store.stat(path);
      await options.store.write(path, bytes, existing ? { mode: existing.mode } : undefined);
      return { path, bytesWritten: bytes.length };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function createWriteTool(options: WriteToolOptions): Tool<z.infer<typeof inputSchema>> {
  return tool({
    description: "Write content to a file. Overwrites any existing file at the path.",
    inputSchema,
    execute: (input) => writeToStore(options, input),
  });
}
