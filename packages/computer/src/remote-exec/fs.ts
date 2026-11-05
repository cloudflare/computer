/**
 * The workspace filesystem remote exec syncs against: the subset of computer's
 * `WorkspaceFilesystem` it uses, so tests can substitute a directory on disk.
 */

export interface SyncDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtime?: number;
}

export interface SyncStat {
  mode: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface SyncFs {
  readdir(path: string, options?: { limit?: number; offset?: number }): Promise<SyncDirent[]>;
  lstat(path: string): Promise<SyncStat>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    options?: { mode?: number },
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

export function join(root: string, rel: string): string {
  return rel === "" ? root : `${root.replace(/\/$/, "")}/${rel}`;
}

export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function sha256(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  // crypto.subtle has no incremental digest; workerd's crypto.DigestStream does, Node's doesn't.
  const Digest = (
    crypto as unknown as {
      DigestStream?: new (
        alg: string,
      ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
    }
  ).DigestStream;
  if (Digest !== undefined) {
    const digest = new Digest("SHA-256");
    await stream.pipeTo(digest);
    return new Uint8Array(await digest.digest);
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", await readAll(stream)));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}
