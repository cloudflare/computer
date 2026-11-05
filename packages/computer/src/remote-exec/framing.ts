/**
 * Cap'n Proto stream framing over Web Streams: a message is a segment table
 * (segment count - 1, then each segment's size in words, padded to 8 bytes) followed by the
 * segments. The reader returns each whole message as one buffer, refusing oversized ones.
 */

/**
 * A stream chunk as bytes. Chunks that crossed Workers RPC into a JS stream can arrive as
 * `ArrayBuffer`s or other views rather than `Uint8Array`s.
 */
export function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new FramingError(`expected bytes, got ${typeof chunk}`);
}

export class FramingError extends Error {
  override name = "FramingError";
}

/** A 1 MiB chunk plus its envelope, or a large manifest. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENTS = 512;

export class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #max: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>, maxBytes = MAX_MESSAGE_BYTES) {
    this.#reader = stream.getReader();
    this.#max = maxBytes;
  }

  /** The next whole message, or undefined at a clean end of stream. */
  async next(): Promise<Uint8Array | undefined> {
    if (!(await this.#fill(4))) {
      if (this.#buffered === 0) return undefined;
      throw new FramingError("stream ended inside a message");
    }
    const segments = this.#peekU32(0) + 1;
    if (segments > MAX_SEGMENTS) throw new FramingError(`message has ${segments} segments`);
    const headerBytes = 4 + 4 * segments + (segments % 2 === 0 ? 4 : 0);
    if (!(await this.#fill(headerBytes)))
      throw new FramingError("stream ended inside a segment table");
    let total = headerBytes;
    for (let i = 0; i < segments; i++) {
      total += this.#peekU32(4 + 4 * i) * 8;
      if (total > this.#max) throw new FramingError(`message is larger than ${this.#max} bytes`);
    }
    if (!(await this.#fill(total))) throw new FramingError("stream ended inside a message");
    return this.#take(total);
  }

  cancel(reason?: unknown): Promise<void> {
    return this.#reader.cancel(reason).catch(() => undefined);
  }

  async #fill(bytes: number): Promise<boolean> {
    while (this.#buffered < bytes) {
      if (this.#done) return false;
      const { value, done } = await this.#reader.read();
      if (done) {
        this.#done = true;
        return this.#buffered >= bytes;
      }
      const chunk = asBytes(value);
      if (chunk.byteLength > 0) {
        this.#chunks.push(chunk);
        this.#buffered += chunk.byteLength;
      }
    }
    return true;
  }

  #peekU32(offset: number): number {
    const bytes = new Uint8Array(4);
    let filled = 0;
    let skip = offset;
    for (const chunk of this.#chunks) {
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength;
        continue;
      }
      const part = chunk.subarray(skip, skip + 4 - filled);
      bytes.set(part, filled);
      filled += part.byteLength;
      skip = 0;
      if (filled === 4) break;
    }
    return new DataView(bytes.buffer).getUint32(0, true);
  }

  #take(bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    let filled = 0;
    while (filled < bytes) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) throw new FramingError("buffer underrun");
      const need = bytes - filled;
      if (chunk.byteLength <= need) {
        out.set(chunk, filled);
        filled += chunk.byteLength;
        this.#chunks.shift();
      } else {
        out.set(chunk.subarray(0, need), filled);
        this.#chunks[0] = chunk.subarray(need);
        filled += need;
      }
    }
    this.#buffered -= bytes;
    return out;
  }
}
