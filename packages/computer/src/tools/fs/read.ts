import { type Tool, tool } from "ai";
import { z } from "zod";
import type { FileStore } from "./types.js";

export interface ReadToolOptions {
  store: FileStore;
  /** Hard line cap. Default 2000. */
  maxLines?: number;
  /** Hard byte cap. Default 256 KiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

const inputSchema = z.object({
  path: z.string().describe("Path to the file to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-indexed)"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

interface ReadResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number | null;
  truncated: boolean;
  nextOffset?: number;
}

/**
 * Memory-efficient line reader. Pulls chunks lazily through the store's
 * `readChunks` iterable; stops the moment the line/byte budget is filled.
 * Never materializes the full file unless the file itself fits within the
 * budget.
 *
 * Returns a continuation `nextOffset` whenever output was truncated so the
 * model can call `read` again with `offset=nextOffset` to keep going. Total
 * line count is reported as `null` when truncation cut us off — counting
 * every line in a multi-megabyte file would defeat the streaming approach.
 */

// Workerd has no Buffer. TextEncoder.encode allocates a Uint8Array per call,
// but it's the only portable byte-length primitive available across Node and
// workers runtimes.
const _enc = new TextEncoder();
function utf8ByteLength(s: string): number {
  return _enc.encode(s).length;
}
export function createReadTool(options: ReadToolOptions): Tool<z.infer<typeof inputSchema>> {
  const { store } = options;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return tool({
    description: `Read the contents of a file. Output is truncated to ${maxLines} lines or ${Math.round(maxBytes / 1024)}KB, whichever is reached first; use offset/limit to page through large files.`,
    inputSchema,
    execute: async ({ path, offset, limit }): Promise<ReadResult | { error: string }> => {
      const stat = await store.stat(path);
      if (!stat) return { error: `File not found: ${path}` };

      const startLine = offset ?? 1;
      const wantedLines = limit ?? maxLines;
      const lineCap = Math.min(wantedLines, maxLines);

      const decoder = new TextDecoder("utf-8");
      let carry = ""; // bytes from previous chunk that didn't end on a newline
      let currentLine = 1; // 1-indexed line we're about to emit
      const collected: string[] = [];
      let collectedBytes = 0;
      let firstEmittedLine: number | null = null;
      let truncatedByBudget = false;
      let firstLineOverflow = false;

      const processLine = (line: string): boolean => {
        // Returns true to keep going, false to stop the outer pump.
        if (currentLine < startLine) {
          currentLine++;
          return true;
        }
        // We're at or past `startLine` — try to emit.
        const lineBytes = utf8ByteLength(line);
        if (collected.length === 0 && lineBytes > maxBytes) {
          firstLineOverflow = true;
          return false;
        }
        // Stop before emitting if this line would push us over either cap.
        if (collected.length >= lineCap) {
          truncatedByBudget = true;
          return false;
        }
        if (collectedBytes + lineBytes + (collected.length > 0 ? 1 : 0) > maxBytes) {
          truncatedByBudget = true;
          return false;
        }
        if (firstEmittedLine === null) firstEmittedLine = currentLine;
        collected.push(line);
        collectedBytes += lineBytes + (collected.length > 1 ? 1 : 0);
        currentLine++;
        return true;
      };

      let keepGoing = true;
      for await (const chunk of store.readChunks(path)) {
        if (!keepGoing) break;
        carry += decoder.decode(chunk, { stream: true });
        // Process every complete line in `carry`. Keep the final partial line
        // for the next iteration.
        let nl = carry.indexOf("\n");
        while (nl !== -1) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          if (!processLine(line)) {
            keepGoing = false;
            break;
          }
          nl = carry.indexOf("\n");
        }
      }
      // Flush the decoder and process any trailing line.
      if (keepGoing) {
        carry += decoder.decode();
        if (carry.length > 0) {
          processLine(carry);
        } else if (currentLine === 1 && stat.size === 0) {
          // empty file
        }
      }

      if (firstLineOverflow) {
        return {
          error: `Line ${currentLine} exceeds the ${maxBytes}-byte read cap. Increase the cap or read a narrower range with offset/limit.`,
        };
      }

      if (firstEmittedLine === null) {
        // Either an empty file (totalLines = 0 or 1) or offset past EOF.
        // currentLine reflects how many lines we've seen so far.
        const linesSeen = currentLine - 1;
        if (stat.size === 0) {
          return {
            path,
            content: "",
            startLine: 1,
            endLine: 0,
            totalLines: 0,
            truncated: false,
          };
        }
        if (offset !== undefined && startLine > Math.max(1, linesSeen)) {
          return { error: `Offset ${offset} is beyond end of file (${linesSeen} line(s))` };
        }
      }

      const startLineActual = firstEmittedLine ?? startLine;
      const endLine = startLineActual + collected.length - 1;
      const truncated = truncatedByBudget;
      const totalLines = truncated ? null : currentLine - 1;
      const nextOffset = truncated ? endLine + 1 : undefined;

      const result: ReadResult = {
        path,
        content: collected.join("\n"),
        startLine: startLineActual,
        endLine,
        totalLines,
        truncated,
      };
      if (nextOffset !== undefined) result.nextOffset = nextOffset;
      return result;
    },
  });
}
