/**
 * `FileStore` adapter over `Workspace.fs`.
 *
 * The AI tools operate on a small file-store contract so their read,
 * write, and edit behavior can stay independent of the full Workspace
 * class. This adapter is the bridge from that contract to the public
 * `workspace.fs` surface.
 *
 * Reads go through `fs.readFile(path)` as a `ReadableStream<Uint8Array>`
 * and are stitched together either chunk-by-chunk (`readChunks`) or all
 * at once (`readAll`).
 */

import type { FileStat, FileStore } from "./types.js";

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
    writeFile(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
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
    if (byteOffset < 0) throw new Error("readChunks: byteOffset must be non-negative");
    if (byteLength !== undefined && byteLength < 0) {
      throw new Error("readChunks: byteLength must be non-negative");
    }
    if (byteLength === 0) return;

    const stream = await this.ws.fs.readFile(path);
    const reader = stream.getReader();
    let skipped = 0;
    let yielded = 0;
    let completed = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        if (!value || value.byteLength === 0) continue;

        let start = 0;
        if (skipped < byteOffset) {
          const needed = byteOffset - skipped;
          if (value.byteLength <= needed) {
            skipped += value.byteLength;
            continue;
          }
          start = needed;
          skipped = byteOffset;
        }

        let end = value.byteLength;
        if (byteLength !== undefined) {
          const remaining = byteLength - yielded;
          if (remaining <= 0) break;
          end = Math.min(end, start + remaining);
        }

        if (end > start) {
          const chunk = value.slice(start, end);
          yielded += chunk.byteLength;
          yield chunk;
        }

        if (byteLength !== undefined && yielded >= byteLength) break;
      }
    } finally {
      if (!completed) await reader.cancel();
      reader.releaseLock();
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
