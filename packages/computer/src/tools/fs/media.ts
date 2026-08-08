import type { FileStore } from "./types.js";

export type DetectedMedia =
  | { kind: "image"; mediaType: string }
  | { kind: "file"; mediaType: "application/pdf" }
  | { kind: "binary"; mediaType: string }
  | { kind: "text"; mediaType: string };

const EXTENSIONS = new Map<string, DetectedMedia>([
  [".png", { kind: "image", mediaType: "image/png" }],
  [".jpg", { kind: "image", mediaType: "image/jpeg" }],
  [".jpeg", { kind: "image", mediaType: "image/jpeg" }],
  [".gif", { kind: "image", mediaType: "image/gif" }],
  [".webp", { kind: "image", mediaType: "image/webp" }],
  [".svg", { kind: "image", mediaType: "image/svg+xml" }],
  [".pdf", { kind: "file", mediaType: "application/pdf" }],
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zig",
]);

export async function detectMedia(
  store: FileStore,
  path: string,
  sniffBytes: number,
): Promise<DetectedMedia> {
  const extension = extensionOf(path);
  const known = EXTENSIONS.get(extension);
  if (known !== undefined) return known;
  if (TEXT_EXTENSIONS.has(extension)) return { kind: "text", mediaType: "text/plain" };

  const prefix = await readPrefix(store, path, sniffBytes);
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mediaType: "image/png" };
  }
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mediaType: "image/jpeg" };
  }
  if (startsWithAscii(prefix, "GIF87a") || startsWithAscii(prefix, "GIF89a")) {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (startsWithAscii(prefix, "RIFF") && asciiAt(prefix, 8, 12) === "WEBP") {
    return { kind: "image", mediaType: "image/webp" };
  }
  if (startsWithAscii(prefix, "%PDF-")) {
    return { kind: "file", mediaType: "application/pdf" };
  }
  if (looksLikeSvg(prefix)) return { kind: "image", mediaType: "image/svg+xml" };
  if (looksLikeText(prefix)) return { kind: "text", mediaType: "text/plain" };
  return { kind: "binary", mediaType: "application/octet-stream" };
}

async function readPrefix(store: FileStore, path: string, length: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of store.readChunks(path, 0, length)) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  if (parts.length === 0) return new Uint8Array();
  if (parts.length === 1) return parts[0];
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  return asciiAt(bytes, 0, prefix.length) === prefix;
}

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes);
  let cursor = skipWhitespace(prefix, 0);

  while (cursor < prefix.length) {
    if (prefix.startsWith("<!--", cursor)) {
      const end = prefix.indexOf("-->", cursor + 4);
      if (end === -1) return false;
      cursor = skipWhitespace(prefix, end + 3);
      continue;
    }
    if (prefix.startsWith("<?", cursor)) {
      const end = prefix.indexOf("?>", cursor + 2);
      if (end === -1) return false;
      cursor = skipWhitespace(prefix, end + 2);
      continue;
    }
    const doctypeEnd = consumeSvgDoctype(prefix, cursor);
    if (doctypeEnd !== null) {
      cursor = skipWhitespace(prefix, doctypeEnd);
      continue;
    }
    break;
  }

  return /^<svg(?:\s|\/?>)/i.test(prefix.slice(cursor));
}

function consumeSvgDoctype(value: string, start: number): number | null {
  const keyword = "<!doctype";
  if (value.slice(start, start + keyword.length).toLowerCase() !== keyword) return null;

  let cursor = start + keyword.length;
  if (!isWhitespace(value[cursor])) return null;
  cursor = skipWhitespace(value, cursor);
  if (value.slice(cursor, cursor + 3).toLowerCase() !== "svg") return null;
  cursor += 3;
  if (!isWhitespace(value[cursor]) && value[cursor] !== "[" && value[cursor] !== ">") return null;

  let quote: '"' | "'" | undefined;
  let subsetDepth = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (value.startsWith("<!--", cursor)) {
      const end = value.indexOf("-->", cursor + 4);
      if (end === -1) return null;
      cursor = end + 3;
      continue;
    }
    if (character === "[") {
      subsetDepth += 1;
    } else if (character === "]" && subsetDepth > 0) {
      subsetDepth -= 1;
    } else if (character === ">" && subsetDepth === 0) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return null;
}

function skipWhitespace(value: string, start: number): number {
  let cursor = start;
  while (isWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/.test(value);
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (bytes.includes(0)) return false;
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return true;
  let replacements = 0;
  for (const char of text) {
    if (char === "\uFFFD") replacements += 1;
  }
  return replacements / text.length < 0.01;
}
