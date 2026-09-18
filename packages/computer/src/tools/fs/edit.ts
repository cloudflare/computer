import { type Tool, tool } from "ai";
import { z } from "zod";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";
import { withFileLock } from "./locks.js";
import type { FileStore } from "./types.js";

export interface EditToolOptions {
  store: FileStore;
  /**
   * Reject edits to files larger than this byte cap. Fuzzy matching needs the
   * whole buffer in memory, so we'd rather force the model to use `write`.
   * Default 2 MiB.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const replacementSchema = z
  .object({
    oldText: z
      .string()
      .describe(
        "Exact text for one targeted replacement. Must be unique in the original file and not overlap with any other edits[].oldText in the same call.",
      ),
    newText: z.string().describe("Replacement text for this targeted edit."),
  })
  .strict();

export const editInputSchema = z.object({
  path: z.string().describe("Path to the file to edit"),
  edits: z
    .array(replacementSchema)
    .describe(
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
    ),
});

export const editDescription =
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes touch the same block, merge them into one edit.";

export interface EditInput {
  path: string;
  edits: Edit[];
}

export interface EditSuccess {
  path: string;
  editsApplied: number;
  diff: string;
  patch: string;
  /** Undefined when the edit produced no line-level change. */
  firstChangedLine: number | undefined;
}

export type EditResult = EditSuccess | { error: string };

/** Best-effort coercion for inputs from quirky models. */
function prepareArguments(input: unknown): { path: string; edits: Edit[] } {
  if (!input || typeof input !== "object") return input as { path: string; edits: Edit[] };
  const args = input as Record<string, unknown>;

  // Some models pack edits into a JSON string.
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      /* fall through to validation error */
    }
  }

  // Legacy single-edit shape: oldText/newText siblings on the root object.
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...(args.edits as Edit[])] : [];
    edits.push({ oldText: args.oldText as string, newText: args.newText as string });
    args.edits = edits;
    delete args.oldText;
    delete args.newText;
  }

  return args as { path: string; edits: Edit[] };
}

/**
 * Apply a batch of targeted replacements to one file.
 *
 * Takes the raw tool input because the coercion in `prepareArguments`
 * has to run before validation: models sometimes pack `edits` into a
 * JSON string or send a single `oldText`/`newText` pair at the root.
 */
export async function editInStore(
  options: EditToolOptions,
  rawInput: unknown,
): Promise<EditResult> {
  const { store } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { path, edits } = prepareArguments(rawInput);

  if (!Array.isArray(edits) || edits.length === 0) {
    return { error: "edits must contain at least one replacement." };
  }

  return withFileLock(store, path, async () => {
    try {
      const stat = await store.stat(path);
      if (!stat) return { error: `File not found: ${path}` };
      if (stat.size > maxBytes) {
        return {
          error: `File too large to edit: ${stat.size} bytes exceeds the ${maxBytes}-byte cap. Use the write tool to rewrite the file from scratch.`,
        };
      }

      const bytes = await store.readAll(path);
      if (!bytes) return { error: `File not found: ${path}` };

      const rawContent = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
      const { bom, text } = stripBom(rawContent);
      const ending = detectLineEnding(text);
      const normalized = normalizeToLF(text);

      let baseContent: string;
      let newContent: string;
      try {
        ({ baseContent, newContent } = applyEditsToNormalizedContent(normalized, edits, path));
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      const finalContent = bom + restoreLineEndings(newContent, ending);
      // Round-trip the file's mode so editing an executable script (or any
      // file with a non-default mode) doesn't silently drop bits. `stat.mode`
      // is undefined for stores that don't track modes; pass `undefined` in
      // that case so the store applies its own default.
      await store.write(path, new TextEncoder().encode(finalContent), { mode: stat.mode });

      const diffResult = generateDiffString(baseContent, newContent);
      const patch = generateUnifiedPatch(path, baseContent, newContent);

      return {
        path,
        editsApplied: edits.length,
        diff: diffResult.diff,
        patch,
        firstChangedLine: diffResult.firstChangedLine,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function createEditTool(options: EditToolOptions): Tool<z.infer<typeof editInputSchema>> {
  return tool({
    description: editDescription,
    inputSchema: editInputSchema,
    execute: (rawInput) => editInStore(options, rawInput),
  });
}
