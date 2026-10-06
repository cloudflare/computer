import { type OutputLimits, OutputWindow } from "./output-tail.js";

/** Why a command's full output could not be saved to a file. */
export class CommandOutputSaveFailed extends Error {
  readonly _tag = "CommandOutputSaveFailed" as const;

  /**
   * @param path - The file the output was being written to.
   * @param cause - What the write failed with.
   */
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(
      `Could not save command output to ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** The outcome of closing an output file. */
export type CommandOutputSaveResult =
  | { readonly _tag: "ok" }
  | { readonly _tag: "err"; readonly error: CommandOutputSaveFailed };

/** One file a command's output streams into. */
export interface CommandOutputFile {
  /** Where the file is in the Workspace. */
  readonly path: string;
  /** Append a chunk. Never blocks; the file is written as chunks arrive. */
  write(chunk: Uint8Array): void;
  /** Finish the file once the output ends. */
  close(): Promise<CommandOutputSaveResult>;
}

/** Where full output goes once it is too long to keep in a result. */
export interface CommandOutputFiles {
  /**
   * Start a file for one stream of one execution.
   *
   * @param name - A file name unique to the execution and stream.
   * @returns The open file.
   */
  open(name: string): CommandOutputFile;
}

/**
 * What a result says about output it cut. The kept part is the end of
 * the output; the full output is in `path` when it could be saved.
 */
export type TruncatedOutput =
  | {
      /** The full output is in `path`. */
      readonly status: "saved";
      /** The Workspace file holding the full output, byte for byte. */
      readonly path: string;
      /** Size of the full output in bytes. */
      readonly totalBytes: number;
      /** Lines in the full output. */
      readonly totalLines: number;
      /** One-based number of the first line kept. */
      readonly firstLine: number;
      /** Whether the kept part starts partway through its first line. */
      readonly partialLine: boolean;
    }
  | {
      /** The full output could not be saved; only the kept part is left. */
      readonly status: "not-saved";
      /** Why saving failed. */
      readonly reason: string;
      /** Size of the full output in bytes. */
      readonly totalBytes: number;
      /** Lines in the full output. */
      readonly totalLines: number;
      /** One-based number of the first line kept. */
      readonly firstLine: number;
      /** Whether the kept part starts partway through its first line. */
      readonly partialLine: boolean;
    };

/** What one stream of output comes to once it ends. */
export interface SpooledOutput {
  /** The whole output when it fit the limits, or its end. */
  readonly bytes: Uint8Array;
  /** Present when the output was cut. */
  readonly truncated?: TruncatedOutput;
}

/**
 * Collect one stream of command output with bounded memory. Output
 * that fits the limits is kept whole. Once it passes them, everything
 * so far and everything after goes to a file, and only a rolling
 * window of the end stays in memory. This mirrors pi's bash tool.
 */
export class OutputSpool {
  readonly #window: OutputWindow;
  readonly #files: CommandOutputFiles;
  readonly #name: string;
  // Chunks held until the output passes the limits, so the file can
  // start with them. Emptied once the file is open.
  #pending: Uint8Array[] = [];
  #file: CommandOutputFile | undefined;
  #finished: Promise<SpooledOutput> | undefined;

  /**
   * @param limits - How much output to keep in memory and in the result.
   * @param files - Where the full output goes once it passes the limits.
   * @param name - The file name to use, unique to the execution and stream.
   */
  constructor(limits: OutputLimits, files: CommandOutputFiles, name: string) {
    this.#window = new OutputWindow(limits);
    this.#files = files;
    this.#name = name;
  }

  /**
   * Add a chunk of output.
   *
   * @param chunk - Raw output bytes.
   */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#window.push(chunk);
    if (this.#file !== undefined) {
      this.#file.write(chunk);
      return;
    }
    this.#pending.push(chunk);
    if (!this.#window.overLimits) return;
    this.#file = this.#files.open(this.#name);
    for (const kept of this.#pending) this.#file.write(kept);
    this.#pending = [];
  }

  /**
   * End the output: close the file, if any, and work out what to keep.
   * Safe to call more than once.
   *
   * @returns The kept bytes and, when the output was cut, where the full output is.
   */
  finish(): Promise<SpooledOutput> {
    this.#finished ??= this.#finish();
    return this.#finished;
  }

  async #finish(): Promise<SpooledOutput> {
    const kept = this.#window.read();
    const file = this.#file;
    if (kept._tag === "whole" || file === undefined) return { bytes: kept.bytes };
    const saved = await file.close();
    const position = {
      totalBytes: this.#window.totalBytes,
      totalLines: this.#window.totalLines,
      firstLine: kept.firstLine,
      partialLine: kept.partialLine,
    };
    return {
      bytes: kept.bytes,
      truncated:
        saved._tag === "ok"
          ? { status: "saved", path: file.path, ...position }
          : { status: "not-saved", reason: saved.error.message, ...position },
    };
  }
}
