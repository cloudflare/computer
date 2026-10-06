// How much of a command's output stays in a result: the same rule pi
// uses for its bash tool. A command's last lines are kept, because
// that is where errors and summaries end up, up to a line limit and a
// byte limit, whichever is hit first.

/** Lines kept from the end of a command's output by default. */
export const DEFAULT_OUTPUT_MAX_LINES = 2000;

/** UTF-8 bytes kept from the end of a command's output by default. */
export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024;

/** How much output to keep: at most `maxLines` lines and `maxBytes` bytes from the end. */
export interface OutputLimits {
  /** The most lines kept. A positive integer. */
  readonly maxLines: number;
  /** The most bytes kept. A positive integer. */
  readonly maxBytes: number;
}

/** The limits used when a caller sets none. */
export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxLines: DEFAULT_OUTPUT_MAX_LINES,
  maxBytes: DEFAULT_OUTPUT_MAX_BYTES,
};

/**
 * Build output limits from optional caller settings, filling in the
 * defaults.
 *
 * @param input - Caller settings; either field may be left out.
 * @param owner - Named in the error, such as `"Workspace output"`.
 * @returns The limits.
 * @throws When a limit is not a positive integer. Limits come from
 *   code, so a bad one is a configuration defect.
 */
export function makeOutputLimits(
  input: { readonly maxLines?: number; readonly maxBytes?: number },
  owner: string,
): OutputLimits {
  const maxLines = input.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
  const maxBytes = input.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  for (const [name, value] of [
    ["maxLines", maxLines],
    ["maxBytes", maxBytes],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${owner}: ${name} must be a positive integer.`);
    }
  }
  return { maxLines, maxBytes };
}

/**
 * Count the lines in output the way an editor shows them: each newline
 * ends a line, and text after the last newline is one more line.
 *
 * @param newlines - Newline bytes seen.
 * @param endsInNewline - Whether the output ends with a newline, or is empty.
 * @returns The line count.
 */
export function lineCount(newlines: number, endsInNewline: boolean): number {
  return newlines + (endsInNewline ? 0 : 1);
}

/** The end of an output that fits the limits, and where it sits in the whole. */
export interface OutputTail {
  /** The kept bytes. Starts on a UTF-8 character boundary. */
  readonly bytes: Uint8Array;
  /** One-based number of the first kept line. */
  readonly firstLine: number;
  /** One-based number of the last kept line. */
  readonly lastLine: number;
  /**
   * Whether the kept bytes start partway through a line. Happens only
   * when the last line alone is longer than `maxBytes`.
   */
  readonly partialLine: boolean;
}

const NEWLINE = 0x0a;

/**
 * Take the end of `window` that fits `limits`. `window` is the end of
 * the whole output, which had `totalLines` lines and ended
 * `endsInNewline`. The tail keeps whole lines where it can, and cuts
 * into the last line only when that line alone is too long.
 *
 * @param window - The last bytes of the output; at least `limits.maxBytes` of them when the output is longer.
 * @param totalLines - Lines in the whole output.
 * @param limits - How much to keep.
 * @returns The kept bytes and the line range they cover.
 */
export function takeTail(window: Uint8Array, totalLines: number, limits: OutputLimits): OutputTail {
  // A trailing newline ends the last line rather than starting one.
  const end =
    window.length > 0 && window[window.length - 1] === NEWLINE ? window.length - 1 : window.length;
  let start = Math.max(0, window.length - limits.maxBytes);
  while (start < window.length && isContinuationByte(window[start])) start += 1;

  let lines = 1;
  let cut = start;
  for (let index = end - 1; index >= start; index -= 1) {
    if (window[index] !== NEWLINE) continue;
    if (lines === limits.maxLines) {
      cut = index + 1;
      break;
    }
    lines += 1;
  }
  const midLine = cut > 0 && window[cut - 1] !== NEWLINE;
  if (midLine) {
    // Drop the partial first line unless it is the only line kept.
    const next = window.indexOf(NEWLINE, cut);
    if (next !== -1 && next < end) {
      cut = next + 1;
      lines -= 1;
    }
  }
  const partialLine = cut > 0 && window[cut - 1] !== NEWLINE;
  return {
    bytes: window.slice(cut),
    firstLine: totalLines - lines + 1,
    lastLine: totalLines,
    partialLine,
  };
}

/**
 * The end of a stream of output, held in bounded memory. Keeps every
 * byte until the output passes `limits`, then a rolling window of the
 * end between 2 and 4 times `maxBytes` long, which always covers what
 * `takeTail` can keep.
 */
export class OutputWindow {
  readonly #limits: OutputLimits;
  #chunks: Uint8Array[] = [];
  #chunkBytes = 0;
  #totalBytes = 0;
  #newlines = 0;
  #endsInNewline = true;

  /**
   * @param limits - How much of the end to be able to keep.
   */
  constructor(limits: OutputLimits) {
    this.#limits = limits;
  }

  /** Bytes pushed so far. */
  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** Lines pushed so far. */
  get totalLines(): number {
    return lineCount(this.#newlines, this.#endsInNewline);
  }

  /** Whether the output so far is longer than the limits allow. */
  get overLimits(): boolean {
    return this.#totalBytes > this.#limits.maxBytes || this.totalLines > this.#limits.maxLines;
  }

  /**
   * Add a chunk of output.
   *
   * @param chunk - Raw output bytes.
   */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#totalBytes += chunk.length;
    for (const byte of chunk) if (byte === NEWLINE) this.#newlines += 1;
    this.#endsInNewline = chunk[chunk.length - 1] === NEWLINE;
    this.#chunks.push(chunk);
    this.#chunkBytes += chunk.length;
    if (this.overLimits) this.#trim();
  }

  /**
   * The kept output: all of it while it fits the limits, otherwise its
   * end and where that sits in the whole.
   *
   * @returns The output, or its tail when the output is too long.
   */
  read():
    | { readonly _tag: "whole"; readonly bytes: Uint8Array }
    | ({ readonly _tag: "tail" } & OutputTail) {
    const window = concat(this.#chunks, this.#chunkBytes);
    if (!this.overLimits) return { _tag: "whole", bytes: window };
    return { _tag: "tail", ...takeTail(window, this.totalLines, this.#limits) };
  }

  // Drop whole chunks from the front while at least 2 x maxBytes stay.
  // A chunk too big to drop whole is cut to the part the window needs.
  #trim(): void {
    const keep = this.#limits.maxBytes * 2;
    if (this.#chunkBytes <= keep * 2) return;
    while (this.#chunks.length > 1) {
      const first = this.#chunks[0];
      if (first === undefined || this.#chunkBytes - first.length < keep) break;
      this.#chunkBytes -= first.length;
      this.#chunks.shift();
    }
    const first = this.#chunks[0];
    if (first !== undefined && this.#chunkBytes > keep * 2) {
      this.#chunks[0] = first.slice(this.#chunkBytes - keep);
      this.#chunkBytes = keep;
    }
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
