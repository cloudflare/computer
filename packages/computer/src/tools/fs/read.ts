import { type JSONValue, type Tool, tool } from "ai";
import { z } from "zod";
import { detectMedia } from "./media.js";
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
  /** Maximum image or PDF size sent inline to the model. Default 3.5 MiB. */
  maxModelBytes?: number;
  /** Prefix bytes inspected when an extension does not identify the file. Default 512. */
  mediaSniffBytes?: number;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_MODEL_BYTES = 3.5 * 1024 * 1024;
const DEFAULT_MEDIA_SNIFF_BYTES = 512;
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

interface MediaReadResult {
  kind: "image" | "file" | "binary";
  path: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  unsupported?: true;
}

type ReadToolResult = ReadResult | MediaReadResult | { error: string };

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
  const maxModelBytes = validateBoundedReadLimit(
    "maxModelBytes",
    options.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES,
  );
  const mediaSniffBytes = options.mediaSniffBytes ?? DEFAULT_MEDIA_SNIFF_BYTES;

  return tool({
    description: `Read a workspace file. Images and PDFs are passed to capable models. Text output is capped at ${maxLines} lines or ${Math.round(maxBytes / 1024)}KB and includes line and byte continuations when truncated.`,
    inputSchema,
    execute: async ({ path, offset, byteOffset, limit }): Promise<ReadToolResult> => {
      const stat = await store.stat(path);
      if (!stat) return { error: `File not found: ${path}` };

      const media = await detectMedia(store, path, mediaSniffBytes);
      if (media.kind !== "text") {
        return {
          kind: media.kind,
          path,
          name: basename(path),
          mediaType: media.mediaType,
          sizeBytes: stat.size,
          ...(media.kind === "binary" ? { unsupported: true as const } : {}),
        };
      }

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
          if (collected.length >= lineCap && afterNewline < stat.size) {
            truncatedByBudget = true;
            nextByteOffset = afterNewline;
            keepGoing = false;
            break;
          }
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
    toModelOutput: async ({ input, output }: { input: unknown; output: unknown }) => {
      if (!isRecord(output)) return { type: "text", value: String(output) };
      if (typeof output.error === "string") {
        return { type: "error-text", value: output.error };
      }
      if (typeof output.content === "string") {
        return output.truncated === true
          ? { type: "json", value: toJSONValue(output) }
          : { type: "text", value: output.content };
      }
      if (output.kind === "binary") return { type: "json", value: toJSONValue(output) };
      if (!isMediaReadResult(output) || !isReadInput(input)) {
        return { type: "json", value: toJSONValue(output) };
      }
      if (output.sizeBytes > maxModelBytes) {
        return inlineMediaLimitError(output, output.sizeBytes, maxModelBytes);
      }
      const currentStat = await store.stat(input.path);
      if (currentStat === null) {
        return { type: "error-text", value: `Could not read file bytes: ${input.path}` };
      }
      if (currentStat.size > maxModelBytes) {
        return inlineMediaLimitError(output, currentStat.size, maxModelBytes);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(store, input.path, maxModelBytes + 1);
      } catch (error) {
        if (isMissingFileError(error)) {
          return { type: "error-text", value: `Could not read file bytes: ${input.path}` };
        }
        throw error;
      }
      if (bytes.byteLength > maxModelBytes) {
        return inlineMediaLimitError(output, bytes.byteLength, maxModelBytes);
      }
      return {
        type: "content",
        value: [
          {
            type: "text",
            text: `Read ${output.path} (${output.mediaType}, ${bytes.byteLength} bytes).`,
          },
          {
            type: "file-data",
            data: uint8ArrayToBase64(bytes),
            mediaType: output.mediaType,
            filename: output.name,
          },
        ],
      };
    },
  });
}

function validateBoundedReadLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${name} must be a positive safe integer below Number.MAX_SAFE_INTEGER`);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readBounded(store: FileStore, path: string, limit: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of store.readChunks(path, 0, limit)) {
    const remaining = limit - total;
    if (remaining <= 0) break;
    const part = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    if (part.byteLength > 0) {
      parts.push(part);
      total += part.byteLength;
    }
    if (total >= limit) break;
  }
  return joinBytes(parts, total);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMediaReadResult(value: unknown): value is MediaReadResult {
  return (
    isRecord(value) &&
    (value.kind === "image" || value.kind === "file") &&
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.sizeBytes === "number"
  );
}

function inlineMediaLimitError(
  output: MediaReadResult,
  sizeBytes: number,
  maxModelBytes: number,
): { type: "error-text"; value: string } {
  return {
    type: "error-text",
    value: `Read ${output.path} (${output.mediaType}, ${sizeBytes} bytes), but it exceeds the ${maxModelBytes}-byte inline model output limit.`,
  };
}

function toJSONValue(value: unknown): JSONValue {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : (JSON.parse(json) as JSONValue);
  } catch {
    return String(value);
  }
}

function isReadInput(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
