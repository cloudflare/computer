// File transfer between a Workspace and a container, without the sync
// protocol.
//
// The sync protocol keeps two SQLite stores converged, which is what a
// FUSE-mounted container needs. A container that works on its own disk
// needs something much smaller: copy these files in, run a command,
// copy those files out. This module is the shared half of that: the
// byte format both ends speak, the HTTP routes computerd serves it on,
// and the rules that turn a caller's pattern into a glob.
//
// A transfer body is a sequence of frames, one per file:
//
//   u32 header length, big-endian | header JSON, UTF-8 | `size` bytes
//
// and a header length of zero ends it. The terminator is what lets a
// receiver tell a finished transfer from one that was cut short; a
// stream that ends anywhere else is an error, not an empty tail.
//
// Paths in headers are relative to the root both ends agreed on, use
// "/" separators, and never contain "." or ".." segments. Each side
// resolves them against its own root, so neither has to trust the
// other's idea of an absolute path.

/** One file in a transfer. */
export interface FileHeader {
  /** Path relative to the transfer root, "/"-separated. */
  readonly path: string;
  /** Exact number of body bytes that follow the header. */
  readonly size: number;
  /** Modification time in epoch milliseconds. */
  readonly mtime: number;
  /** Permission bits, such as 0o644. */
  readonly mode: number;
  /**
   * The Workspace revision of this file, on a push. The container
   * records it as the version it holds, which is what lets a later
   * pull tell whether the Workspace has changed the file since.
   */
  readonly rev?: number;
}

/** What one side knows about a file, for deciding whether to send it. */
export interface FileManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  /** The Workspace revision of the file, when the Workspace sends it. */
  readonly rev?: number;
}

/**
 * A file a pull refused to bring back, because the Workspace and the
 * container both changed it since the container last matched the
 * Workspace.
 *
 * - `"modified"`: the container recorded the Workspace at `baseRev`,
 *   the Workspace is now at the newer `localRev`, and the container's
 *   copy changed too.
 * - `"untracked"`: the Workspace has the file but the container holds
 *   no record of it, so there is no base to compare against. A file
 *   created on both sides, or a container restarted since the push,
 *   lands here.
 */
export interface FileConflict {
  readonly path: string;
  readonly reason: "modified" | "untracked";
  readonly localRev: number;
  readonly baseRev?: number;
}

/** The body of a 409 from the pull route when it found conflicts. */
export interface FileConflictResponse {
  readonly conflicts: readonly FileConflict[];
}

/** Thrown by a pull that found conflicts and was not forced. */
export class FileTransferConflictError extends Error {
  override readonly name = "FileTransferConflictError";
  readonly conflicts: readonly FileConflict[];

  constructor(conflicts: readonly FileConflict[]) {
    const shown = conflicts.slice(0, 10).map((conflict) => conflict.path);
    const more =
      conflicts.length > shown.length ? ` and ${conflicts.length - shown.length} more` : "";
    super(
      `pull refused: ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed in both the workspace and the container: ${shown.join(", ")}${more}. Pass { force: true } to overwrite the workspace copies.`,
    );
    this.conflicts = conflicts;
  }
}

/** A file to encode. `body` is called once, when the encoder reaches it. */
export interface OutgoingFile {
  readonly header: FileHeader;
  readonly body: () => Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

/**
 * A decoded file. Read or cancel `body` before asking the iterator for
 * the next file; whatever is left unread is discarded when it moves on.
 */
export interface IncomingFile {
  readonly header: FileHeader;
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Routes computerd serves file transfer on. All of them sit behind the
 * client secret like the rest of its surface.
 *
 * - `diff`: POST `{ files: FileManifestEntry[] }`, answers
 *   `{ want: string[] }`, the paths the container does not already
 *   hold at that revision, or with that size and modification time.
 * - `put`: PUT a transfer body. Answers `{ written, bytes }`. Each
 *   header's `rev` is recorded as the revision the container holds.
 * - `pull`: POST `{ patterns, exclude?, have?, force? }`, answers a
 *   transfer body of the matching files the caller lacks. When a file
 *   changed on both sides it answers 409 with a
 *   {@link FileConflictResponse} instead, and sends nothing, unless
 *   `force` is set.
 * - `record`: POST `{ files: [{ path, rev }] }` after writing a pull's
 *   files, naming the revision the Workspace gave each one. Answers
 *   `{ recorded }`.
 */
export const FILE_TRANSFER_ROUTES = {
  diff: "/files/diff",
  put: "/files",
  pull: "/files/pull",
  record: "/files/record",
} as const;

/** Content type of a transfer body. */
export const FILE_TRANSFER_CONTENT_TYPE = "application/vnd.cloudflare.computer.files";

// A header is a path and three numbers. Anything near this size is a
// corrupt length prefix, and refusing it beats allocating whatever the
// prefix asks for.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MODE = 0o7777;
const GLOB_CHARACTERS = /[*?{]/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Thrown when a transfer body is malformed or ends early. */
export class FileTransferError extends Error {
  override readonly name = "FileTransferError";
}

/**
 * Encode files into a transfer body.
 *
 * The stream pulls one file at a time, so a large transfer never holds
 * more than a chunk in memory. A body whose length differs from its
 * header's `size`, such as a file that changed while it was being
 * sent, errors the stream rather than misframing everything after it.
 */
export function encodeFiles(
  files: Iterable<OutgoingFile> | AsyncIterable<OutgoingFile>,
): ReadableStream<Uint8Array> {
  const frames = encodeFrames(files);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await frames.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await frames.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

async function* encodeFrames(
  files: Iterable<OutgoingFile> | AsyncIterable<OutgoingFile>,
): AsyncGenerator<Uint8Array, void, undefined> {
  for await (const file of files) {
    const header = checkHeader(file.header);
    const json = encoder.encode(JSON.stringify(header));
    yield concat(u32(json.length), json);
    const body = await file.body();
    let sent = 0;
    if (body instanceof Uint8Array) {
      sent = body.length;
      if (sent > 0 && sent === header.size) yield body;
    } else {
      const reader = body.getReader();
      try {
        while (sent <= header.size) {
          const { value, done } = await reader.read();
          if (done) break;
          sent += value.length;
          if (sent <= header.size && value.length > 0) yield value;
        }
      } finally {
        if (sent > header.size) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (sent !== header.size) {
      throw new FileTransferError(
        `${header.path} changed while it was sent: expected ${header.size} bytes, read ${sent > header.size ? "more" : sent}.`,
      );
    }
  }
  yield u32(0);
}

/**
 * Decode a transfer body into files.
 *
 * Read or cancel each file's `body` before asking for the next one.
 * The iterator throws {@link FileTransferError} when the body is
 * malformed or ends before its terminator, so a partial transfer is
 * never mistaken for a complete one.
 *
 * @yields Each file in the order it was sent, with its header and a
 *   stream of exactly `header.size` body bytes.
 */
export async function* decodeFiles(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<IncomingFile, void, undefined> {
  const reader = new ByteReader(stream.getReader());
  let finished = false;
  try {
    while (true) {
      const length = readU32(await reader.exact(4));
      if (length === 0) {
        if (!(await reader.atEnd())) {
          throw new FileTransferError("Transfer has bytes after its terminator.");
        }
        finished = true;
        return;
      }
      if (length > MAX_HEADER_BYTES) {
        throw new FileTransferError(`Transfer header is ${length} bytes, over the limit.`);
      }
      const header = parseHeader(decoder.decode(await reader.exact(length)));
      let remaining = header.size;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (remaining === 0) {
              controller.close();
              return;
            }
            const chunk = await reader.upTo(remaining);
            remaining -= chunk.length;
            controller.enqueue(chunk);
            if (remaining === 0) controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      yield { header, body };
      // Whatever the consumer left unread belongs to this file, and has
      // to go before the next header lines up.
      while (remaining > 0) {
        const chunk = await reader.upTo(remaining);
        remaining -= chunk.length;
      }
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.release();
  }
}

/**
 * Whether `path` is a valid transfer path: relative, "/"-separated,
 * with no empty, "." or ".." segments and no NUL byte.
 */
export function isTransferPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Turn a caller's pattern into globs relative to `root`.
 *
 * A pattern is relative to `root`, or absolute under it. A leading
 * "./" and a trailing "/" are dropped, and "." or `root` itself means
 * everything. A pattern without glob characters names a file or a
 * directory, so it becomes two globs: the path, and everything below
 * it. `pull(["dist"])` therefore fetches the whole directory.
 *
 * @throws TypeError for an empty pattern, RangeError for one outside
 *   `root` or containing a ".." segment.
 */
export function normalizeTransferPattern(pattern: string, root: string): string[] {
  if (typeof pattern !== "string") throw new TypeError("A pattern must be a string.");
  let path = pattern.trim();
  if (path === "") throw new TypeError("A pattern must not be empty.");
  const base = trimRoot(root);
  if (path.startsWith("/")) {
    if (path === base || path === `${base}/`) path = "";
    else if (base === "/") path = path.slice(1);
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length + 1);
    else throw new RangeError(`${JSON.stringify(pattern)} is outside ${base}.`);
  }
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/+$/, "");
  if (path === "" || path === ".") return ["**"];
  if (path.split("/").includes("..")) {
    throw new RangeError(`${JSON.stringify(pattern)} must not contain "..".`);
  }
  if (!GLOB_CHARACTERS.test(path)) return [path, `${path}/**`];
  return [path];
}

/**
 * Split a glob into the literal directory it starts in and the rest.
 * A walk can begin at `base` instead of the root: nothing outside it
 * can match. `rest` is never empty.
 *
 *   "src/**\/*.ts" -> { base: "src", rest: "**\/*.ts" }
 *   "package.json" -> { base: "", rest: "package.json" }
 */
export function splitPatternBase(glob: string): { base: string; rest: string } {
  const segments = glob.split("/");
  let literal = 0;
  while (literal < segments.length - 1 && !GLOB_CHARACTERS.test(segments[literal] ?? "")) {
    literal += 1;
  }
  return {
    base: segments.slice(0, literal).join("/"),
    rest: segments.slice(literal).join("/"),
  };
}

function trimRoot(root: string): string {
  if (!root.startsWith("/")) throw new TypeError(`Root must be absolute, got ${root}.`);
  const trimmed = root.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function checkHeader(header: FileHeader): FileHeader {
  if (!isTransferPath(header.path)) {
    throw new FileTransferError(`Invalid transfer path ${JSON.stringify(header.path)}.`);
  }
  if (!Number.isSafeInteger(header.size) || header.size < 0) {
    throw new FileTransferError(`Invalid size for ${header.path}.`);
  }
  if (!Number.isFinite(header.mtime) || header.mtime < 0) {
    throw new FileTransferError(`Invalid mtime for ${header.path}.`);
  }
  if (!Number.isInteger(header.mode) || header.mode < 0 || header.mode > MAX_MODE) {
    throw new FileTransferError(`Invalid mode for ${header.path}.`);
  }
  if (header.rev !== undefined && !isRevision(header.rev)) {
    throw new FileTransferError(`Invalid rev for ${header.path}.`);
  }
  return {
    path: header.path,
    size: header.size,
    mtime: header.mtime,
    mode: header.mode,
    ...(header.rev === undefined ? {} : { rev: header.rev }),
  };
}

/** Whether `value` is a valid Workspace revision: a non-negative safe integer. */
export function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseHeader(text: string): FileHeader {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FileTransferError("Transfer header is not JSON.");
  }
  if (typeof value !== "object" || value === null) {
    throw new FileTransferError("Transfer header is not an object.");
  }
  return checkHeader(value as FileHeader);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function readU32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Reads exact byte counts out of a chunked stream. Only header reads
// copy; body reads hand back slices of the chunks as they arrive.
class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async exact(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      if (!(await this.#fill())) throw new FileTransferError("Transfer ended early.");
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  async upTo(length: number): Promise<Uint8Array> {
    if (this.#buffer.length === 0 && !(await this.#fill())) {
      throw new FileTransferError("Transfer ended early.");
    }
    const take = Math.min(length, this.#buffer.length);
    const out = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    return out;
  }

  async atEnd(): Promise<boolean> {
    if (this.#buffer.length > 0) return false;
    return !(await this.#fill());
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }

  release(): void {
    try {
      this.#reader.releaseLock();
    } catch {
      // A read still pending; the stream is cancelled either way.
    }
  }

  async #fill(): Promise<boolean> {
    // Empty chunks are legal on a byte stream and carry nothing.
    while (true) {
      const { value, done } = await this.#reader.read();
      if (done) return false;
      if (value.length === 0) continue;
      this.#buffer = this.#buffer.length === 0 ? value : concat(this.#buffer, value);
      return true;
    }
  }
}
