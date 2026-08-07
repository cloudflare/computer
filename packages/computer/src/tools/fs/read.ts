import { type Tool, tool } from "ai";
import { z } from "zod";
import type { FileStore } from "./types.js";

export type LineTruncation = { bytes: number } | { chars: number };

export interface ReadToolOptions {
  store: FileStore;
  /** Hard line cap. Default 2000. */
  maxLines?: number;
  /** Hard output byte cap. Default 256 KiB. */
  maxBytes?: number;
  /** Prefix each returned line with its 1-indexed line number. Default false. */
  includeLineNumbers?: boolean;
  /** Shorten individual lines before applying the output byte cap. */
  lineTruncation?: LineTruncation;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "... (truncated)";

const inputSchema = z.object({
  path: z.string().describe("Path to the file to read"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Line number to start reading from (1-indexed)"),
  byteOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte continuation returned by a previous read. Pass it with offset to avoid rescanning.",
    ),
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
  nextByteOffset?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function createReadTool(options: ReadToolOptions): Tool<z.infer<typeof inputSchema>> {
  const { store } = options;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const includeLineNumbers = options.includeLineNumbers ?? false;
  const lineTruncation = validateLineTruncation(options.lineTruncation);

  return tool({
    description: `Read a text file. Output is capped at ${maxLines} lines or ${Math.round(maxBytes / 1024)}KB. A truncated result includes line and byte continuations for the next page.`,
    inputSchema,
    execute: async ({
      path,
      offset,
      byteOffset,
      limit,
    }): Promise<ReadResult | { error: string }> => {
      const stat = await store.stat(path);
      if (!stat) return { error: `File not found: ${path}` };

      const startLine = offset ?? 1;
      const startByte = byteOffset ?? 0;
      const lineCap = Math.min(limit ?? maxLines, maxLines);
      let currentLine = byteOffset === undefined ? 1 : startLine;
      const collected: string[] = [];
      let collectedBytes = 0;
      let firstEmittedLine: number | null = null;
      let truncatedByBudget = false;
      let firstLineOverflow = false;
      let nextByteOffset: number | undefined;

      const processLine = (
        lineBytes: Uint8Array,
        actualBytes: number,
        lineStart: number,
      ): boolean => {
        if (currentLine < startLine) {
          currentLine += 1;
          return true;
        }
        if (collected.length >= lineCap) {
          truncatedByBudget = true;
          nextByteOffset = lineStart;
          return false;
        }

        const line = renderLine(
          truncateLine(lineBytes, actualBytes, lineTruncation),
          currentLine,
          includeLineNumbers,
        );
        const outputBytes = utf8ByteLength(line) + (collected.length > 0 ? 1 : 0);
        if (collected.length === 0 && outputBytes > maxBytes) {
          firstLineOverflow = true;
          return false;
        }
        if (collectedBytes + outputBytes > maxBytes) {
          truncatedByBudget = true;
          nextByteOffset = lineStart;
          return false;
        }

        if (firstEmittedLine === null) firstEmittedLine = currentLine;
        collected.push(line);
        collectedBytes += outputBytes;
        currentLine += 1;
        return true;
      };

      const keepBytes = bytesToRetain(lineTruncation, maxBytes);
      let keptParts: Uint8Array[] = [];
      let keptLength = 0;
      let actualLength = 0;
      let absoluteOffset = startByte;
      let lineStart = startByte;
      let keepGoing = true;

      const append = (part: Uint8Array): void => {
        actualLength += part.byteLength;
        const available = keepBytes - keptLength;
        if (available <= 0) return;
        const kept = part.byteLength <= available ? part : part.subarray(0, available);
        if (kept.byteLength > 0) {
          keptParts.push(kept);
          keptLength += kept.byteLength;
        }
      };
      const finishLine = (): boolean => {
        const bytes = joinBytes(keptParts, keptLength);
        const result = processLine(bytes, actualLength, lineStart);
        keptParts = [];
        keptLength = 0;
        actualLength = 0;
        return result;
      };

      for await (const chunk of store.readChunks(path, startByte)) {
        let cursor = 0;
        while (cursor < chunk.byteLength) {
          const newline = chunk.indexOf(0x0a, cursor);
          if (newline === -1) {
            append(chunk.subarray(cursor));
            break;
          }
          append(chunk.subarray(cursor, newline));
          const afterNewline = absoluteOffset + newline + 1;
          if (!finishLine()) {
            keepGoing = false;
            break;
          }
          lineStart = afterNewline;
          cursor = newline + 1;
        }
        absoluteOffset += chunk.byteLength;
        if (!keepGoing) break;
      }
      if (keepGoing && actualLength > 0) finishLine();

      if (firstLineOverflow) {
        return {
          error: `Line ${currentLine} exceeds the ${maxBytes}-byte read cap. Increase the cap or configure lineTruncation.`,
        };
      }

      if (firstEmittedLine === null) {
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
      const result: ReadResult = {
        path,
        content: collected.join("\n"),
        startLine: startLineActual,
        endLine,
        totalLines: truncated ? null : currentLine - 1,
        truncated,
      };
      if (truncated) {
        result.nextOffset = endLine + 1;
        result.nextByteOffset = nextByteOffset;
      }
      return result;
    },
  });
}

function validateLineTruncation(value: LineTruncation | undefined): LineTruncation | undefined {
  if (value === undefined) return undefined;
  const amount = "bytes" in value ? value.bytes : value.chars;
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new TypeError("lineTruncation must be a positive safe integer");
  }
  return value;
}

function bytesToRetain(truncation: LineTruncation | undefined, maxBytes: number): number {
  if (truncation === undefined) return maxBytes + 1;
  return "bytes" in truncation ? truncation.bytes : truncation.chars * 4;
}

function truncateLine(
  bytes: Uint8Array,
  actualBytes: number,
  truncation: LineTruncation | undefined,
): string {
  if (truncation === undefined) return decoder.decode(bytes);
  if ("bytes" in truncation) {
    if (actualBytes <= truncation.bytes) return decoder.decode(bytes);
    return `${decodeUtf8Prefix(bytes.subarray(0, truncation.bytes))}${TRUNCATION_MARKER}`;
  }
  const text = decoder.decode(bytes);
  const chars = Array.from(text);
  if (chars.length <= truncation.chars && actualBytes === bytes.byteLength) return text;
  return `${chars.slice(0, truncation.chars).join("")}${TRUNCATION_MARKER}`;
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = bytes.byteLength; end >= Math.max(0, bytes.byteLength - 3); end -= 1) {
    try {
      return fatalDecoder.decode(bytes.subarray(0, end));
    } catch {
      // The byte limit split a multibyte character; remove one more byte.
    }
  }
  return decoder.decode(bytes);
}

function renderLine(line: string, lineNumber: number, includeLineNumbers: boolean): string {
  return includeLineNumbers ? `${lineNumber}\t${line}` : line;
}

function joinBytes(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array();
  if (parts.length === 1) return parts[0];
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
