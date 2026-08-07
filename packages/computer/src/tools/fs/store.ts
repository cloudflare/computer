/**
 * `FileStore` adapter over `Workspace.fs`.
 *
 * The AI tools operate on a small file-store contract so their read,
 * write, and edit behavior can stay independent of the full Workspace
 * class. This adapter is the bridge from that contract to the public
 * `workspace.fs` surface.
 *
 * Bounded reads go through `fs.readRange`; whole-file reads used by edit
 * and multimodal output still drain `fs.readFile(path)`.
 */

import type { FileStat, FileStore } from "./types.js";

const RANGE_CHUNK_BYTES = 64 * 1024;

/**
 * Structural subset of `@cloudflare/computer.Workspace` the tools
 * depend on.
 */
export interface WorkspaceLike {
  fs: {
    stat(path: string): Promise<{
      size: number;
      mtime: number;
      mode: number;
      isFile: boolean;
      isDirectory: boolean;
    }>;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    readdir(
      path: string,
      options?: { limit?: number; offset?: number },
    ): Promise<
      Array<{
        name: string;
        size: number;
        mtime: number;
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
      }>
    >;
  };
}

export class WorkspaceFileStore implements FileStore {
  constructor(private readonly ws: WorkspaceLike) {}

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await this.ws.fs.stat(path);
      if (!s.isFile) return null;
      return { size: s.size, mtime: s.mtime, mode: s.mode };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async readAll(path: string): Promise<Uint8Array | null> {
    try {
      const stream = await this.ws.fs.readFile(path);
      return await drain(stream);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async write(path: string, content: Uint8Array, opts?: { mode?: number }): Promise<void> {
    await ensureParentDir(this.ws, path);
    await this.ws.fs.writeFile(path, content, opts);
  }

  async *readChunks(path: string, byteOffset = 0, byteLength?: number): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      throw new Error("readChunks: byteOffset must be a non-negative safe integer");
    }
    if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) {
      throw new Error("readChunks: byteLength must be a non-negative safe integer");
    }
    if (byteLength === 0) return;

    const stat = await this.ws.fs.stat(path);
    let remaining = Math.max(0, stat.size - byteOffset);
    if (byteLength !== undefined) remaining = Math.min(remaining, byteLength);
    let offset = byteOffset;
    while (remaining > 0) {
      const requested = Math.min(remaining, RANGE_CHUNK_BYTES);
      const chunk = await this.ws.fs.readRange(path, offset, requested);
      if (chunk.byteLength === 0) return;
      yield chunk;
      offset += chunk.byteLength;
      remaining -= chunk.byteLength;
      if (chunk.byteLength < requested) return;
    }
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

async function ensureParentDir(ws: WorkspaceLike, path: string): Promise<void> {
  const i = path.lastIndexOf("/");
  if (i <= 0) return;
  const parent = path.slice(0, i);
  await ws.fs.mkdir(parent, { recursive: true });
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}
