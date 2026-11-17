// Reading and writing a Kitebuild program's descriptors in full, waiting
// on pipes and stopping when the process is told to.

import { type FdEntry, type JsProgramCtx, writeFdBytes } from "@cloudflare/kitebuild-core";

export const EPIPE = 32;

// Writes every byte to `fd`, waiting while a pipe is full. Returns 0, or
// the negative errno of the write that failed.
export async function writeAll(ctx: JsProgramCtx, fd: number, bytes: Uint8Array): Promise<number> {
  const entry = ctx.proc.fdt.get(fd) ?? undefined;
  for (let offset = 0; offset < bytes.length;) {
    if (ctx.signal.aborted) return -EPIPE;
    const left = bytes.length - offset;
    const special = entry?.node.special;
    const written = special?.writeAsyncCancelable
      ? await cancelOnAbort(special.writeAsyncCancelable(bytes, offset, left, entry), ctx.signal)
      : special?.writeAsync
        ? await special.writeAsync(bytes, offset, left, entry)
        : writeFdBytes(ctx.proc.fdt, fd, bytes, offset, left);
    if (written <= 0) return written < 0 ? written : -EPIPE;
    offset += written;
  }
  return 0;
}

// Reads `fd` to its end, as text, or null when the read fails or the
// process is told to stop first.
export async function readAll(ctx: JsProgramCtx, fd: number): Promise<string | null> {
  const entry = ctx.proc.fdt.get(fd);
  if (entry === null) return "";
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const read = await readSome(entry, chunk, ctx.signal);
    if (read < 0 || ctx.signal.aborted) return null;
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function readSome(entry: FdEntry, into: Uint8Array, signal: AbortSignal): Promise<number> {
  const special = entry.node.special;
  if (special?.readAsyncCancelable) {
    return cancelOnAbort(special.readAsyncCancelable(into, 0, into.length, entry), signal);
  }
  if (special?.readAsync) return special.readAsync(into, 0, into.length, entry);
  if (special?.read) return special.read(into, 0, into.length, entry);
  const body = entry.node.type === "reg" ? entry.node.body : undefined;
  if (body === undefined) return 0;
  const read = body.readInto(into, entry.offset);
  entry.offset += read;
  return read;
}

// Settles with the operation's result, or -1 once the process is told to
// stop, cancelling the operation so it does not hold the pipe.
function cancelOnAbort(
  operation: { promise: Promise<number>; cancel: () => void },
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) {
    operation.cancel();
    return Promise.resolve(-1);
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      operation.cancel();
      resolve(-1);
    };
    signal.addEventListener("abort", stop, { once: true });
    operation.promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}
