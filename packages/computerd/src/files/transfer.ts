// File transfer on the container's own disk.
//
// When computerd runs with FUSE_MOUNT=none there is no mount point and
// nothing syncs. The host moves files in and out explicitly through the
// routes in FILE_TRANSFER_ROUTES, and this class is what those routes
// call, rooted at the container's "/": a transfer path such as
// "workspace/src/a.ts" is /workspace/src/a.ts on disk. It reads and
// writes the real filesystem with node:fs; it never touches computerd's
// VFS. The class takes any root, which is what its tests use.
//
// It keeps a manifest, in memory, of every file that last matched the
// Workspace: the Workspace revision, and the SHA-256, size and mtime of
// the bytes on disk at that moment. A push records each file it writes
// at the revision the host sent; a pull records each file it sent once
// the host reports the revision it wrote it at. With that record:
//
//   - A push skips a file the container already holds at the host's
//     revision. A file the container changed since keeps its change:
//     the Workspace has nothing newer to give it.
//   - A pull skips a file the container has not changed since the
//     record, whatever the Workspace did to it since. Size and mtime
//     answer that cheaply; when they differ, the content hash decides,
//     so a command that rewrites a file with identical bytes is not a
//     change.
//   - A pull refuses a file both sides changed: the container's copy
//     differs from the record and the Workspace's revision is newer
//     than the recorded one. Bringing it back would overwrite the
//     Workspace's change, so the whole pull is refused, before any
//     bytes move, unless the caller forces it.
//
// A file with no record falls back to size and mtime. A container-side
// copy that looks changed against a Workspace copy that exists is
// refused too, as "untracked": there is no base to say which side
// changed. That is what a computerd restart looks like, since the
// manifest does not survive one.
//
// Paths from the host are confined to the root lexically. The
// container is the workload's own machine, so this guards against
// mistakes, not against the commands running in it.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dir } from "node:fs";
import { chmod, lstat, mkdir, opendir, rename, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  decodeFiles,
  encodeFiles,
  type FileConflict,
  type FileManifestEntry,
  FileTransferError,
  isTransferPath,
  normalizeTransferPattern,
  type OutgoingFile,
  splitPatternBase,
} from "@cloudflare/computer-rpc/files";
import { compileGlob } from "@cloudflare/dofs";

/** A file on the container's disk that a pattern matched. */
export interface LocalFile {
  readonly path: string;
  readonly absolute: string;
  readonly size: number;
  readonly mtime: number;
  readonly mode: number;
}

/** Which files to pull, and what the caller already has. */
export interface PullRequest {
  readonly patterns: readonly string[];
  readonly exclude?: readonly string[];
  readonly have?: readonly FileManifestEntry[];
  /** Send every matching file and skip the conflict check. */
  readonly force?: boolean;
}

/** A pull's outcome: the files to stream, or why there are none. */
export type PullPlan =
  | { readonly stream: ReadableStream<Uint8Array>; readonly conflicts?: undefined }
  | { readonly conflicts: readonly FileConflict[]; readonly stream?: undefined };

/** What the container recorded about a file that last matched the Workspace. */
export interface RecordedFile {
  /** The Workspace revision the file matched. */
  readonly rev: number;
  /** SHA-256 of the bytes on disk, hex. */
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
}

type DiskVersion = Omit<RecordedFile, "rev">;

// Kernel filesystems under a root of "/". Their files report a size of
// zero and then produce bytes, which no transfer can frame, and /proc
// alone is effectively unbounded. A walk never enters them.
const VIRTUAL_DIRECTORIES = new Set(["proc", "sys", "dev"]);

export class FileTransfer {
  readonly root: string;
  readonly #manifest = new Map<string, RecordedFile>();
  // Files a pull sent, waiting for the host to report the revision it
  // wrote them at. Only a reported file joins the manifest: one the
  // host failed to write must not be taken as matching the Workspace.
  readonly #sent = new Map<string, DiskVersion>();

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error(`File transfer root must be absolute: ${root}`);
    this.root = path.resolve(root);
  }

  /** The record for `relative`, if any. For tests and diagnostics. */
  recorded(relative: string): RecordedFile | undefined {
    return this.#manifest.get(relative);
  }

  /** Paths in `files` the container does not already hold. */
  async diff(files: readonly FileManifestEntry[]): Promise<string[]> {
    const want: string[] = [];
    for (const entry of files) {
      const local = await this.#statFile(this.#checkPath(entry.path));
      if (local === undefined) {
        want.push(entry.path);
        continue;
      }
      const recorded = this.#manifest.get(entry.path);
      if (recorded !== undefined && entry.rev !== undefined) {
        if (recorded.rev !== entry.rev) want.push(entry.path);
        continue;
      }
      if (local.size !== entry.size || !sameTime(local.mtime, entry.mtime)) want.push(entry.path);
    }
    return want;
  }

  /**
   * Write every file in a transfer body to disk. Each file lands under
   * a temporary name and is renamed into place, so a command never sees
   * a half-written file and a failed transfer leaves no partial ones.
   * A file sent with a revision is recorded at it.
   */
  async receive(body: ReadableStream<Uint8Array>): Promise<{ written: number; bytes: number }> {
    let written = 0;
    let bytes = 0;
    for await (const incoming of decodeFiles(body)) {
      const { header } = incoming;
      const target = this.#resolve(header.path);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.computerd-${randomUUID()}`;
      const hash = createHash("sha256");
      try {
        await pipeline(
          Readable.fromWeb(incoming.body as import("node:stream/web").ReadableStream<Uint8Array>),
          hashing(hash),
          createWriteStream(temporary, { mode: header.mode }),
        );
        // createWriteStream's mode is masked by the umask; set it exactly.
        await chmod(temporary, header.mode);
        const seconds = header.mtime / 1000;
        await utimes(temporary, seconds, seconds);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.#sent.delete(header.path);
      const local = await this.#statFile(header.path);
      if (header.rev !== undefined && local !== undefined) {
        this.#manifest.set(header.path, {
          rev: header.rev,
          hash: hash.digest("hex"),
          size: local.size,
          mtime: local.mtime,
        });
      } else {
        this.#manifest.delete(header.path);
      }
      written += 1;
      bytes += header.size;
    }
    return { written, bytes };
  }

  /** Files under the root matching `patterns` and not `exclude`. */
  async list(patterns: readonly string[], exclude: readonly string[] = []): Promise<LocalFile[]> {
    const globs = patterns.flatMap((pattern) => normalizeTransferPattern(pattern, this.root));
    const includes = globs.map((glob) => compileGlob(glob));
    const excludes = exclude
      .flatMap((pattern) => normalizeTransferPattern(pattern, this.root))
      .map((glob) => compileGlob(glob));
    const found = new Map<string, LocalFile>();
    for (const base of walkBases(globs)) {
      await this.#walk(base, includes, excludes, found);
    }
    return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Decide what a pull sends. Returns the conflicts and no stream when
   * any file changed on both sides and `force` is not set, so a refused
   * pull moves nothing.
   */
  async send(request: PullRequest): Promise<PullPlan> {
    const have = new Map((request.have ?? []).map((entry) => [entry.path, entry]));
    const files = await this.list(request.patterns, request.exclude);
    const outgoing: LocalFile[] = [];
    const conflicts: FileConflict[] = [];
    for (const file of files) {
      if (request.force === true) {
        outgoing.push(file);
        continue;
      }
      const known = have.get(file.path);
      const recorded = this.#manifest.get(file.path);
      if (recorded !== undefined) {
        // The container has not touched it since it matched the
        // Workspace: there is nothing to bring back.
        if (await this.#unchanged(file, recorded)) continue;
        if (known?.rev !== undefined && known.rev > recorded.rev) {
          conflicts.push({
            path: file.path,
            reason: "modified",
            localRev: known.rev,
            baseRev: recorded.rev,
          });
          continue;
        }
        outgoing.push(file);
        continue;
      }
      if (known === undefined) {
        outgoing.push(file);
        continue;
      }
      // No record. A container copy no newer than the Workspace's, at
      // the same size, is taken as the same file.
      if (known.size === file.size && file.mtime <= known.mtime) continue;
      if (known.rev !== undefined) {
        conflicts.push({ path: file.path, reason: "untracked", localRev: known.rev });
        continue;
      }
      // A host that sends no revisions predates conflict checks, and
      // gets the size and mtime behaviour it was built for.
      outgoing.push(file);
    }
    if (conflicts.length > 0) return { conflicts };
    return { stream: encodeFiles(outgoing.map((file) => this.#outgoing(file))) };
  }

  /**
   * Record the revisions the Workspace wrote a pull's files at, making
   * them the container's base for the next transfer. Paths this
   * container did not send are ignored. Returns how many were recorded.
   */
  record(files: ReadonlyArray<{ readonly path: string; readonly rev: number }>): number {
    let recorded = 0;
    for (const { path: relative, rev } of files) {
      this.#checkPath(relative);
      const sent = this.#sent.get(relative);
      if (sent === undefined) continue;
      this.#sent.delete(relative);
      this.#manifest.set(relative, { rev, ...sent });
      recorded += 1;
    }
    return recorded;
  }

  #outgoing(file: LocalFile): OutgoingFile {
    return {
      header: { path: file.path, size: file.size, mtime: file.mtime, mode: file.mode },
      body: async () => {
        const hash = createHash("sha256");
        const sent = this.#sent;
        const source = Readable.toWeb(
          createReadStream(file.absolute),
        ) as unknown as ReadableStream<Uint8Array>;
        // Hash the bytes as they go, so the record describes what the
        // host received rather than what the file holds by the time it
        // reports back.
        return source.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              hash.update(chunk);
              controller.enqueue(chunk);
            },
            flush() {
              sent.set(file.path, {
                hash: hash.digest("hex"),
                size: file.size,
                mtime: file.mtime,
              });
            },
          }),
        );
      },
    };
  }

  // Whether the file on disk still holds the bytes the record
  // describes. A matching size and mtime is taken on trust, as git
  // does; otherwise the content is hashed.
  async #unchanged(file: LocalFile, recorded: RecordedFile): Promise<boolean> {
    if (file.size !== recorded.size) return false;
    if (file.mtime === recorded.mtime) return true;
    const hash = await hashFile(file.absolute);
    if (hash !== recorded.hash) return false;
    // Touched, not changed. Remember the new mtime so the next check
    // does not hash it again.
    this.#manifest.set(file.path, { ...recorded, mtime: file.mtime });
    return true;
  }

  #isVirtual(relative: string): boolean {
    return this.root === "/" && VIRTUAL_DIRECTORIES.has(relative.split("/")[0] ?? "");
  }

  #checkPath(relative: string): string {
    if (!isTransferPath(relative)) {
      throw new FileTransferError(`Invalid transfer path ${JSON.stringify(relative)}.`);
    }
    return relative;
  }

  #resolve(relative: string): string {
    const absolute = path.resolve(this.root, ...this.#checkPath(relative).split("/"));
    if (!absolute.startsWith(this.root === "/" ? "/" : `${this.root}${path.sep}`)) {
      throw new FileTransferError(`${relative} resolves outside ${this.root}.`);
    }
    return absolute;
  }

  async #statFile(relative: string): Promise<LocalFile | undefined> {
    const absolute = this.#resolve(relative);
    try {
      const stats = await lstat(absolute);
      if (!stats.isFile()) return undefined;
      return {
        path: relative,
        absolute,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
        mode: stats.mode & 0o7777,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async #walk(
    base: string,
    includes: readonly RegExp[],
    excludes: readonly RegExp[],
    found: Map<string, LocalFile>,
  ): Promise<void> {
    if (base !== "" && this.#isVirtual(base)) return;
    const start = base === "" ? this.root : this.#resolve(base);
    try {
      if (!(await lstat(start)).isDirectory()) return;
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (base !== "" && excludedPath(base, excludes)) return;
    const pending: string[] = [base];
    while (pending.length > 0) {
      const directory = pending.pop() as string;
      const absoluteDirectory = directory === "" ? this.root : this.#resolve(directory);
      let handle: Dir;
      try {
        handle = await opendir(absoluteDirectory);
      } catch (error) {
        // Removed while the walk was running.
        if (isNotFound(error)) continue;
        throw error;
      }
      for await (const entry of handle) {
        const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
        if (directory === "" && this.#isVirtual(relative)) continue;
        if (excludes.some((regex) => regex.test(relative))) continue;
        if (entry.isDirectory()) {
          pending.push(relative);
          continue;
        }
        // Symbolic links, sockets and devices are left out: a transfer
        // carries regular files only.
        if (!entry.isFile() || found.has(relative)) continue;
        if (!includes.some((regex) => regex.test(relative))) continue;
        const file = await this.#statFile(relative);
        if (file !== undefined) found.set(relative, file);
      }
    }
  }
}

function hashing(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function hashFile(absolute: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The directories a walk has to start from to cover `globs`, with any
// directory inside another one dropped. A glob that starts with a
// literal directory only needs that directory walked.
function walkBases(globs: readonly string[]): string[] {
  const bases = [...new Set(globs.map((glob) => splitPatternBase(glob).base))].sort();
  const out: string[] = [];
  for (const base of bases) {
    const covered = out.some((kept) => kept === "" || base === kept || base.startsWith(`${kept}/`));
    if (!covered) out.push(base);
  }
  return out;
}

// Whether a directory, or any directory above it, matches an exclusion.
// A walk that starts below the root never visits those ancestors, so
// they are checked here once instead.
function excludedPath(relative: string, excludes: readonly RegExp[]): boolean {
  const segments = relative.split("/");
  for (let i = 1; i <= segments.length; i += 1) {
    const prefix = segments.slice(0, i).join("/");
    if (excludes.some((regex) => regex.test(prefix))) return true;
  }
  return false;
}

// Disk mtimes carry sub-millisecond precision that the host's do not,
// and utimes rounds through seconds as a float. Whole milliseconds are
// what both ends can agree on.
function sameTime(a: number, b: number): boolean {
  return Math.floor(a) === Math.floor(b);
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
