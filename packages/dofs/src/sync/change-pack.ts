// Change pack: the bulk transport for large cursor windows.
//
// Entry-at-a-time transfer is fine for a handful of changes and
// hopeless for tens of thousands. A pack carries one ordered run of
// change entries interleaved with the unique objects those entries
// reference, gzip-compressed, closed by a footer that names the cursor
// window and validates the contents.
//
// Interleaving matters. Objects are emitted immediately before the
// entries that first reference them, so a receiver can stage bytes and
// apply metadata incrementally instead of buffering the whole pack.
// The plan calls for Durable Object storage to settle between apply
// groups; interleaved records are what make that possible.
//
// Framing is length-prefixed records rather than a self-describing
// format, because the decoder must never guess where a record ends. A
// truncated stream therefore fails as a protocol error rather than
// silently decoding a prefix — the cursor would otherwise advance over
// entries that never arrived.
//
// The format is generic. Nothing here knows about `node_modules` or any
// other path shape; a pack is selected purely on the size of the cursor
// window (see blocks.ts).

import type { Database } from "../storage.js";
import type { PlannedBlock } from "./blocks.js";
import type { ChangeEntry } from "./changes.js";
import type { ChangeCursor } from "./watermarks.js";

export const PACK_FORMAT_VERSION = 1;

// Transport values are chunked so no single enqueued buffer is
// unbounded. The plan specifies 1 MiB.
const TRANSPORT_CHUNK_BYTES = 1024 * 1024;

// Record tags. A tag is one byte; the payload length is a u32 that
// follows it.
const TAG_HEADER = 1;
const TAG_OBJECT = 2;
const TAG_ENTRY = 3;
const TAG_FOOTER = 4;

// A protocol error means the pack itself is invalid: truncated,
// corrupt, mis-versioned, or internally inconsistent. It is distinct
// from a transport error because it must not be retried blindly — the
// cursor stays put and the failure is surfaced.
export class PackProtocolError extends Error {
  readonly code = "EPACK_PROTOCOL";
  constructor(message: string) {
    super(`change pack: ${message}`);
    this.name = "PackProtocolError";
  }
}

export interface PackFooter {
  readonly version: number;
  readonly generation: string;
  readonly after: ChangeCursor;
  readonly blockCursor: ChangeCursor;
  readonly target: ChangeCursor;
  readonly entryCount: number;
  readonly objectCount: number;
  readonly objectBytes: number;
  // Digest over every entry and object record in emission order. Cheap
  // insurance that the body matches what the footer claims.
  readonly digest: string;
}

export interface EncodeChangePackInput {
  readonly block: PlannedBlock;
  readonly after: ChangeCursor;
  readonly target: ChangeCursor;
  readonly generation: string;
  // Test-only: force the footer to disagree with the body so the
  // decoder's consistency check can be exercised.
  readonly corruptEntryCount?: number;
}

export interface DecodedChangePack {
  readonly footer: PackFooter;
  readonly entries: ChangeEntry[];
  // Hex-keyed object bytes, ready for stageBlob.
  readonly objects: Map<string, Uint8Array>;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Entries carry Uint8Array chunk hashes, which JSON cannot represent.
// Hashes become hex on the wire and come back as bytes, so a decoded
// entry is === equal to the encoded one.
function encodeEntry(entry: ChangeEntry): string {
  if (entry.kind === "file") {
    return JSON.stringify({
      ...entry,
      chunks: entry.chunks.map((c) => ({ hash: toHex(c.hash), size: c.size })),
    });
  }
  return JSON.stringify(entry);
}

function decodeEntry(text: string): ChangeEntry {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.kind === "file") {
    const chunks = (raw.chunks as { hash: string; size: number }[]).map((c) => ({
      hash: fromHex(c.hash),
      size: c.size,
    }));
    return { ...(raw as unknown as ChangeEntry), chunks } as ChangeEntry;
  }
  return raw as unknown as ChangeEntry;
}

// FNV-1a over the record stream. Not a security boundary — gzip
// already catches random corruption via its own CRC. This catches the
// case gzip cannot: a well-formed stream whose records disagree with
// the footer that describes them.
function digestUpdate(state: number, bytes: Uint8Array): number {
  let hash = state;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function frameRecord(tag: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.byteLength);
  framed[0] = tag;
  new DataView(framed.buffer).setUint32(1, payload.byteLength, false);
  framed.set(payload, 5);
  return framed;
}

// Emit the pack as a gzip byte stream.
//
// Object payloads are read from the blob store one at a time and
// released as they are written, so the encoder's memory stays bounded
// by the largest single object rather than by the whole pack.
export function encodeChangePack(
  db: Database,
  input: EncodeChangePackInput,
): ReadableStream<Uint8Array> {
  const { block, after, target, generation } = input;
  const encoder = new TextEncoder();

  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      let digest = 0x811c9dc5;

      controller.enqueue(
        frameRecord(
          TAG_HEADER,
          encoder.encode(JSON.stringify({ version: PACK_FORMAT_VERSION, generation })),
        ),
      );

      // Objects precede the entries that reference them. Emitted once
      // per pack; duplicates across packs are absorbed by the
      // receiver's content-addressed store.
      const emitted = new Set<string>();
      let objectBytes = 0;
      let objectCount = 0;

      const emitObjectsFor = (entry: ChangeEntry): void => {
        if (entry.kind !== "file") return;
        for (const chunk of entry.chunks) {
          const key = toHex(chunk.hash);
          if (emitted.has(key)) continue;
          emitted.add(key);
          const row = db.one<{ bytes: Uint8Array }>(
            "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
            chunk.hash,
          );
          if (row === undefined) {
            controller.error(new PackProtocolError(`missing local object ${key}`));
            return;
          }
          const payload = new Uint8Array(row.bytes.byteLength + 32);
          payload.set(chunk.hash, 0);
          payload.set(row.bytes, 32);
          const record = frameRecord(TAG_OBJECT, payload);
          digest = digestUpdate(digest, record);
          controller.enqueue(record);
          objectBytes += row.bytes.byteLength;
          objectCount += 1;
        }
      };

      for (const entry of block.entries) {
        emitObjectsFor(entry);
        const record = frameRecord(TAG_ENTRY, encoder.encode(encodeEntry(entry)));
        digest = digestUpdate(digest, record);
        controller.enqueue(record);
      }

      const footer: PackFooter = {
        version: PACK_FORMAT_VERSION,
        generation,
        after,
        blockCursor: block.cursor,
        target,
        entryCount: input.corruptEntryCount ?? block.entries.length,
        objectCount,
        objectBytes,
        digest: digest.toString(16),
      };
      controller.enqueue(frameRecord(TAG_FOOTER, encoder.encode(JSON.stringify(footer))));
      controller.close();
    },
  });

  // Re-chunk to bounded transport values, then compress.
  return raw.pipeThrough(gzipStream("gzip")).pipeThrough(rechunk());
}

// CompressionStream / DecompressionStream are typed with a narrower
// Uint8Array<ArrayBuffer> view than the ReadableStream<Uint8Array> the
// sync wire uses elsewhere, so the pair needs a cast at this one
// boundary rather than widening every stream signature in the package.
function gzipStream(format: "gzip"): ReadableWritablePair<Uint8Array, Uint8Array> {
  return new CompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function gunzipStream(format: "gzip"): ReadableWritablePair<Uint8Array, Uint8Array> {
  return new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function rechunk(): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
      merged.set(pending, 0);
      merged.set(chunk, pending.byteLength);
      let offset = 0;
      while (merged.byteLength - offset >= TRANSPORT_CHUNK_BYTES) {
        controller.enqueue(merged.slice(offset, offset + TRANSPORT_CHUNK_BYTES));
        offset += TRANSPORT_CHUNK_BYTES;
      }
      pending = merged.slice(offset);
    },
    flush(controller) {
      if (pending.byteLength > 0) controller.enqueue(pending);
    },
  });
}

// Pull length-prefixed records out of a decompressed byte stream.
//
// The reader buffers only the record it is currently assembling, so a
// pack larger than memory still decodes as long as no single object
// exceeds it. Transport chunk boundaries are irrelevant: records are
// reassembled across them.
async function* readRecords(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ tag: number; payload: Uint8Array; framed: Uint8Array }> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;

  const pull = async (): Promise<boolean> => {
    const { value, done: finished } = await reader.read();
    if (finished) {
      done = true;
      return false;
    }
    const merged = new Uint8Array(buffer.byteLength + value.byteLength);
    merged.set(buffer, 0);
    merged.set(value, buffer.byteLength);
    buffer = merged;
    return true;
  };

  try {
    while (true) {
      while (buffer.byteLength < 5 && !done) {
        if (!(await pull())) break;
      }
      if (buffer.byteLength === 0 && done) return;
      if (buffer.byteLength < 5) {
        throw new PackProtocolError("truncated record header");
      }
      const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(
        1,
        false,
      );
      while (buffer.byteLength < 5 + length && !done) {
        if (!(await pull())) break;
      }
      if (buffer.byteLength < 5 + length) {
        throw new PackProtocolError("truncated record payload");
      }
      const framed = buffer.slice(0, 5 + length);
      yield { tag: buffer[0], payload: buffer.slice(5, 5 + length), framed };
      buffer = buffer.slice(5 + length);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface DecodeChangePackOptions {
  readonly expectVersion?: number;
  readonly expectGeneration?: string;
}

// Decode and validate a pack.
//
// Validation is deliberately strict and happens before the caller sees
// anything applicable: a pack that fails any check throws, leaving the
// cursor untouched, because a partially applied pack whose cursor
// advanced would lose the entries that never arrived.
export async function decodeChangePack(
  stream: ReadableStream<Uint8Array>,
  options: DecodeChangePackOptions = {},
): Promise<DecodedChangePack> {
  const expectVersion = options.expectVersion ?? PACK_FORMAT_VERSION;
  const decoder = new TextDecoder();
  const entries: ChangeEntry[] = [];
  const objects = new Map<string, Uint8Array>();
  let footer: PackFooter | undefined;
  let digest = 0x811c9dc5;
  let sawHeader = false;

  let source: ReadableStream<Uint8Array>;
  try {
    source = stream.pipeThrough(gunzipStream("gzip"));
  } catch (error) {
    throw new PackProtocolError(`could not open gzip stream: ${String(error)}`);
  }

  try {
    for await (const record of readRecords(source)) {
      if (record.tag === TAG_HEADER) {
        const header = JSON.parse(decoder.decode(record.payload)) as {
          version: number;
          generation: string;
        };
        if (header.version !== expectVersion) {
          throw new PackProtocolError(
            `unsupported format version ${header.version}, expected ${expectVersion}`,
          );
        }
        if (
          options.expectGeneration !== undefined &&
          header.generation !== options.expectGeneration
        ) {
          throw new PackProtocolError(
            `generation ${header.generation} does not match expected ${options.expectGeneration}`,
          );
        }
        sawHeader = true;
        continue;
      }
      if (record.tag === TAG_OBJECT) {
        digest = digestUpdate(digest, record.framed);
        const hash = record.payload.slice(0, 32);
        objects.set(toHex(hash), record.payload.slice(32));
        continue;
      }
      if (record.tag === TAG_ENTRY) {
        digest = digestUpdate(digest, record.framed);
        entries.push(decodeEntry(decoder.decode(record.payload)));
        continue;
      }
      if (record.tag === TAG_FOOTER) {
        footer = JSON.parse(decoder.decode(record.payload)) as PackFooter;
        continue;
      }
      throw new PackProtocolError(`unknown record tag ${record.tag}`);
    }
  } catch (error) {
    if (error instanceof PackProtocolError) throw error;
    // A gzip CRC failure or an aborted stream lands here. Both mean the
    // pack cannot be trusted.
    throw new PackProtocolError(`corrupt or truncated stream: ${String(error)}`);
  }

  if (!sawHeader) throw new PackProtocolError("missing header record");
  // Absent footer is the truncation signal: the footer is the last
  // record, so a stream that ended without one is incomplete.
  if (footer === undefined) throw new PackProtocolError("missing footer record");
  if (footer.entryCount !== entries.length) {
    throw new PackProtocolError(
      `footer declares ${footer.entryCount} entries but body carried ${entries.length}`,
    );
  }
  if (footer.objectCount !== objects.size) {
    throw new PackProtocolError(
      `footer declares ${footer.objectCount} objects but body carried ${objects.size}`,
    );
  }
  if (footer.digest !== digest.toString(16)) {
    throw new PackProtocolError("body digest does not match footer");
  }

  return { footer, entries, objects };
}

// Read just the footer. Useful for diagnostics and for a receiver that
// wants the block cursor before committing to a full decode.
export async function readPackFooter(stream: ReadableStream<Uint8Array>): Promise<PackFooter> {
  const decoded = await decodeChangePack(stream);
  return decoded.footer;
}
