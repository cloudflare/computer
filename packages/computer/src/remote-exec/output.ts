/**
 * Large output, following the Workspace's spill-over settings.
 *
 * The same rules as the runtime's `output-files.ts`, over exec's own byte streams: a result keeps
 * the tail of each stream within `maxLines` and `maxBytes`; once a stream passes either limit,
 * all of it is streamed into `<dir>/<name>`, and the result's `truncated` entry names that file.
 * Files matching `*.stdout.log` / `*.stderr.log` beyond `keep` are pruned, newest kept, so the
 * Workspace's own saved output and exec's share one budget.
 */
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_OUTPUT_KEEP,
  type WorkspaceOutputOptions,
} from "../runtime/output-files";
import type { TruncatedOutput } from "../runtime/output-spool";
import type { WorkspaceRuntimeTruncation } from "../runtime/types";
import { asBytes } from "./framing";
import { isNotFound, type SyncFs } from "./fs";

export type { TruncatedOutput, WorkspaceOutputOptions };
export type Truncation = WorkspaceRuntimeTruncation;

export interface OutputSettings {
  maxLines: number;
  maxBytes: number;
  /** Undefined when saving is off (`output: false`). */
  dir: string | undefined;
  keep: number;
}

export function outputSettings(
  options: WorkspaceOutputOptions | false | undefined,
): OutputSettings {
  if (options === false) return { maxLines: 2000, maxBytes: 64 * 1024, dir: undefined, keep: 0 };
  return {
    maxLines: options?.maxLines ?? 2000,
    maxBytes: options?.maxBytes ?? 64 * 1024,
    dir: options?.dir ?? DEFAULT_OUTPUT_DIR,
    keep: options?.keep ?? DEFAULT_OUTPUT_KEEP,
  };
}

const NEWLINE = 0x0a;
const OUTPUT_FILE = /\.(stdout|stderr)\.log$/;

export interface Captured {
  kept: Uint8Array;
  truncated?: TruncatedOutput;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Consume one output stream: keep its tail, spill all of it once it passes the limits. */
export class OutputCapture {
  readonly #fs: SyncFs;
  readonly #settings: OutputSettings;
  readonly #name: string;
  /** Everything so far, until the stream is spilled. */
  #head: Uint8Array[] = [];
  /** The last `maxBytes` bytes. */
  #tail: Uint8Array[] = [];
  #tailBytes = 0;
  #totalBytes = 0;
  #newlines = 0;
  #lastByte = -1;
  #spill:
    | { writer: WritableStreamDefaultWriter<Uint8Array>; written: Promise<void>; path: string }
    | undefined;
  #spillError: unknown;

  constructor(fs: SyncFs, settings: OutputSettings, name: string) {
    this.#fs = fs;
    this.#settings = settings;
    this.#name = name;
  }

  get #lines(): number {
    return this.#newlines + (this.#totalBytes > 0 && this.#lastByte !== NEWLINE ? 1 : 0);
  }

  get #overLimits(): boolean {
    return this.#totalBytes > this.#settings.maxBytes || this.#lines > this.#settings.maxLines;
  }

  async write(raw: Uint8Array): Promise<void> {
    const chunk = asBytes(raw);
    if (chunk.byteLength === 0) return;
    this.#totalBytes += chunk.byteLength;
    for (const b of chunk) if (b === NEWLINE) this.#newlines++;
    this.#lastByte = chunk[chunk.byteLength - 1] ?? -1;
    this.#tail.push(chunk);
    this.#tailBytes += chunk.byteLength;
    // One byte more than `maxBytes`, so the byte before the kept part is known (partialLine).
    for (
      let first = this.#tail[0];
      first && this.#tailBytes - first.byteLength >= this.#settings.maxBytes + 1;
      first = this.#tail[0]
    ) {
      this.#tailBytes -= first.byteLength;
      this.#tail.shift();
    }
    if (this.#spill === undefined && this.#head !== undefined) {
      this.#head.push(chunk);
      if (this.#overLimits) await this.#startSpill();
    } else if (this.#spill !== undefined) {
      await this.#spill.writer.write(chunk).catch((e: unknown) => {
        this.#spillError ??= e;
      });
    }
  }

  async #startSpill(): Promise<void> {
    const head = this.#head;
    this.#head = [];
    const dir = this.#settings.dir;
    if (dir === undefined) return;
    const path = `${dir}/${this.#name}`;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      undefined,
      new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
    );
    const writer = writable.getWriter();
    const written = (async () => {
      await this.#fs.mkdir(dir, { recursive: true });
      await this.#fs.writeFile(path, readable);
    })().catch((e: unknown) => {
      this.#spillError ??= e;
      void readable.cancel().catch(() => undefined);
    });
    this.#spill = { writer, written, path };
    for (const chunk of head)
      await writer.write(chunk).catch((e: unknown) => (this.#spillError ??= e));
  }

  async consume(stream: ReadableStream<Uint8Array>): Promise<Captured> {
    for await (const chunk of stream) await this.write(chunk);
    return this.finish();
  }

  async finish(): Promise<Captured> {
    if (!this.#overLimits) return { kept: concat(this.#head) };
    let kept = concat(this.#tail);
    let skippedBefore = this.#totalBytes - kept.byteLength;
    if (kept.byteLength > this.#settings.maxBytes) {
      const cut = kept.byteLength - this.#settings.maxBytes;
      kept = kept.subarray(cut);
      skippedBefore += cut;
    }
    let keptLines = 0;
    for (let i = kept.byteLength - 1, seen = 0; i >= 0; i--) {
      if (kept[i] === NEWLINE && i !== kept.byteLength - 1) {
        seen++;
        if (seen >= this.#settings.maxLines) {
          skippedBefore += i + 1;
          kept = kept.subarray(i + 1);
          break;
        }
      }
    }
    for (const b of kept) if (b === NEWLINE) keptLines++;
    if (kept.byteLength > 0 && kept[kept.byteLength - 1] !== NEWLINE) keptLines++;
    const totalLines = this.#lines;
    // The kept part starts mid-line unless the byte before it was a newline.
    const partialLine =
      skippedBefore > 0 && !(await this.#byteBeforeWasNewline(kept, skippedBefore));
    const firstLine = Math.max(1, totalLines - keptLines + 1);
    const base = { totalBytes: this.#totalBytes, totalLines, firstLine, partialLine };
    if (this.#spill === undefined) {
      return {
        kept: kept.slice(),
        truncated: { status: "not-saved", reason: "saving output is turned off", ...base },
      };
    }
    await this.#spill.writer.close().catch((e: unknown) => (this.#spillError ??= e));
    await this.#spill.written;
    if (this.#spillError !== undefined) {
      const reason =
        this.#spillError instanceof Error ? this.#spillError.message : String(this.#spillError);
      return { kept: kept.slice(), truncated: { status: "not-saved", reason, ...base } };
    }
    await this.#prune(this.#spill.path);
    return { kept: kept.slice(), truncated: { status: "saved", path: this.#spill.path, ...base } };
  }

  async #byteBeforeWasNewline(kept: Uint8Array, skippedBefore: number): Promise<boolean> {
    // The tail window always holds the byte just before the kept part unless the cut fell on a
    // chunk boundary; in that case check the window's own bytes.
    const window = concat(this.#tail);
    const offsetInWindow = window.byteLength - kept.byteLength - 1;
    if (offsetInWindow >= 0) return window[offsetInWindow] === NEWLINE;
    return skippedBefore === 0;
  }

  async #prune(saved: string): Promise<void> {
    const dir = this.#settings.dir;
    if (dir === undefined) return;
    try {
      const others = (await this.#fs.readdir(dir))
        .filter((e) => e.isFile && OUTPUT_FILE.test(e.name) && `${dir}/${e.name}` !== saved)
        .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      for (const stale of others.slice(Math.max(0, this.#settings.keep - 1))) {
        await this.#fs.rm(`${dir}/${stale.name}`, { force: true }).catch((e: unknown) => {
          if (!isNotFound(e)) throw e;
        });
      }
    } catch {
      // Pruning is best effort, as in computer.
    }
  }
}
