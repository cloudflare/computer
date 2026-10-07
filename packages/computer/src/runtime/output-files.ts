import type { WorkspaceFilesystem } from "@cloudflare/dofs";

import {
  type CommandOutputFile,
  type CommandOutputFiles,
  CommandOutputSaveFailed,
  type CommandOutputSaveResult,
} from "./output-spool.js";

import { makeOutputLimits } from "./output-tail.js";

/** How a Workspace cuts command output and where it saves the rest. */
export interface WorkspaceOutputOptions {
  /** The most lines a result keeps per stream. Defaults to 2000. */
  readonly maxLines?: number;
  /** The most bytes a result keeps per stream. Defaults to 64 KiB. */
  readonly maxBytes?: number;
  /** The absolute Workspace directory full output is saved in. Defaults to `/.computer/output`. */
  readonly dir?: string;
  /** How many saved output files to keep, newest first. Defaults to 50. */
  readonly keep?: number;
}

/**
 * Check a Workspace's `output` option when the Workspace is built, so a
 * bad setting fails at construction rather than on the first command.
 *
 * @param input - The option as given.
 * @returns The option, unchanged.
 * @throws When a limit or `keep` is not a positive integer, or `dir` is
 *   not an absolute path without a trailing slash.
 */
export function parseOutputOptions(
  input: WorkspaceOutputOptions | false | undefined,
): WorkspaceOutputOptions | false {
  if (input === false) return false;
  const options = input ?? {};
  makeOutputLimits(options, "Workspace output");
  const { dir, keep } = options;
  if (dir !== undefined && (!dir.startsWith("/") || dir.length < 2 || dir.endsWith("/"))) {
    throw new Error("Workspace output: dir must be an absolute path without a trailing slash.");
  }
  if (keep !== undefined && (!Number.isInteger(keep) || keep <= 0)) {
    throw new Error("Workspace output: keep must be a positive integer.");
  }
  return options;
}

/** Where saved output goes when a Workspace sets no `output.dir`. */
export const DEFAULT_OUTPUT_DIR = "/.computer/output";

/** Saved output files kept per Workspace when it sets no `output.keep`. */
export const DEFAULT_OUTPUT_KEEP = 50;

// Output queued for the file before a writer waits for storage.
const QUEUE_HIGH_WATER_BYTES = 1024 * 1024;

// The names this class gives files, so cleanup leaves anything else in
// the directory alone.
const OUTPUT_FILE = /\.(stdout|stderr)\.log$/;

/**
 * Save command output to files in a Workspace directory, keeping only
 * the newest `keep` of them. Output streams into the file as it
 * arrives through the filesystem's chunked writer, so a long run never
 * holds the whole output in memory.
 */
export class WorkspaceCommandOutputFiles implements CommandOutputFiles {
  readonly #fs: Pick<WorkspaceFilesystem, "mkdir" | "writeFile" | "readdir" | "rm">;
  readonly #dir: string;
  readonly #keep: number;

  /**
   * @param fs - The Workspace filesystem.
   * @param dir - The absolute directory output files go in.
   * @param keep - How many output files to keep; older ones are removed.
   */
  constructor(
    fs: Pick<WorkspaceFilesystem, "mkdir" | "writeFile" | "readdir" | "rm">,
    dir: string,
    keep: number,
  ) {
    this.#fs = fs;
    this.#dir = dir;
    this.#keep = keep;
  }

  /**
   * Start a file for one stream of one execution.
   *
   * @param name - A file name unique to the execution and stream.
   * @returns The open file.
   */
  open(name: string): CommandOutputFile {
    const path = `${this.#dir}/${name}`;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    // Set once the write fails or the file is closed, after which the
    // stream no longer takes chunks.
    let open = true;
    // Writers waiting for the queue to drain below its high-water mark.
    let waiting: Array<() => void> = [];
    const release = () => {
      const resolved = waiting;
      waiting = [];
      for (const resolve of resolved) resolve();
    };
    const content = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          release();
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: QUEUE_HIGH_WATER_BYTES }),
    );
    const written = this.#write(path, content).then((result) => {
      open = false;
      release();
      return result;
    });
    return {
      path,
      write: async (chunk) => {
        if (!open || controller === undefined) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) > 0) return;
        await new Promise<void>((resolve) => waiting.push(resolve));
      },
      close: async () => {
        if (open) {
          open = false;
          controller?.close();
        }
        const result = await written;
        if (result._tag === "ok") await this.#prune(path);
        return result;
      },
    };
  }

  async #write(
    path: string,
    content: ReadableStream<Uint8Array>,
  ): Promise<CommandOutputSaveResult> {
    try {
      await this.#fs.mkdir(this.#dir, { recursive: true });
      await this.#fs.writeFile(path, content);
      return { _tag: "ok" };
    } catch (error) {
      // Drain what is still queued so the producer side never stalls.
      await content.cancel().catch(() => undefined);
      return { _tag: "err", error: new CommandOutputSaveFailed(path, error) };
    }
  }

  // Remove the oldest output files past `keep`, never the one just
  // saved and never a file this class did not name. Best effort: a
  // failed cleanup must not fail the command whose output was saved.
  async #prune(saved: string): Promise<void> {
    try {
      const entries = await this.#fs.readdir(this.#dir);
      const others = entries
        .filter(
          (entry) =>
            entry.isFile && OUTPUT_FILE.test(entry.name) && `${this.#dir}/${entry.name}` !== saved,
        )
        .sort((a, b) => b.mtime - a.mtime);
      for (const stale of others.slice(this.#keep - 1)) {
        await this.#fs.rm(`${this.#dir}/${stale.name}`, { force: true });
      }
    } catch {
      // Left for the next save to retry.
    }
  }
}
