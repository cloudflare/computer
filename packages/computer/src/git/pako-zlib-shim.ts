// pako compatibility layer backed by the Workers / Node `node:zlib`
// implementation.
//
// isomorphic-git imports pako for three things: synchronous
// `deflate`, synchronous `inflate`, and an `Inflate` instance whose
// `push()` call exposes `result`, `err`, `msg`, and
// `strm.avail_in`. Workers provide native zlib through nodejs_compat,
// so the package build aliases `pako` here instead of bundling pako's
// JavaScript zlib port.

import * as zlib from "node:zlib";

export type Data = string | ArrayBuffer | ArrayBufferView;

export interface PakoOptions extends zlib.ZlibOptions {
  raw?: boolean;
  gzip?: boolean;
  to?: "string";
}

export interface PakoStream {
  avail_in: number;
}

type ZlibInfoResult = {
  buffer: Uint8Array;
  engine?: {
    bytesWritten?: number;
  };
};

type ZlibError = Error & {
  code?: string;
  errno?: number;
};

const UTF8_ENCODER = /* @__PURE__ */ new TextEncoder();
const UTF8_DECODER = /* @__PURE__ */ new TextDecoder();

function toBytes(data: Data): Uint8Array {
  if (typeof data === "string") return UTF8_ENCODER.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toZlibOptions(options: PakoOptions = {}): zlib.ZlibOptions {
  const { gzip: _gzip, raw: _raw, to: _to, ...zlibOptions } = options;
  return zlibOptions;
}

function normalizeOutput(out: Uint8Array, options?: PakoOptions): Uint8Array | string {
  if (options?.to === "string") return UTF8_DECODER.decode(out);
  return out;
}

export function deflate(data: Data, options?: PakoOptions): Uint8Array | string {
  const input = toBytes(data);
  const zlibOptions = toZlibOptions(options);
  const out = options?.gzip
    ? zlib.gzipSync(input, zlibOptions)
    : options?.raw
      ? zlib.deflateRawSync(input, zlibOptions)
      : zlib.deflateSync(input, zlibOptions);
  return normalizeOutput(out, options);
}

export function deflateRaw(data: Data, options?: PakoOptions): Uint8Array | string {
  return normalizeOutput(zlib.deflateRawSync(toBytes(data), toZlibOptions(options)), options);
}

export function gzip(data: Data, options?: PakoOptions): Uint8Array | string {
  return normalizeOutput(zlib.gzipSync(toBytes(data), toZlibOptions(options)), options);
}

export function inflate(data: Data, options?: PakoOptions): Uint8Array | string {
  const input = toBytes(data);
  const zlibOptions = toZlibOptions(options);
  const out = options?.raw
    ? zlib.inflateRawSync(input, zlibOptions)
    : zlib.inflateSync(input, zlibOptions);
  return normalizeOutput(out, options);
}

export function inflateRaw(data: Data, options?: PakoOptions): Uint8Array | string {
  return normalizeOutput(zlib.inflateRawSync(toBytes(data), toZlibOptions(options)), options);
}

export function ungzip(data: Data, options?: PakoOptions): Uint8Array | string {
  return normalizeOutput(zlib.gunzipSync(toBytes(data), toZlibOptions(options)), options);
}

function isIncompleteInput(error: ZlibError): boolean {
  return error.code === "Z_BUF_ERROR" || error.errno === zlib.constants.Z_BUF_ERROR;
}

function pakoErrno(error: ZlibError): number {
  return typeof error.errno === "number" ? error.errno : 1;
}

export class Inflate {
  err = 0;
  msg = "";
  result: Uint8Array | string | undefined;
  readonly strm: PakoStream = { avail_in: 0 };

  readonly #chunks: Uint8Array[] = [];
  readonly #options: PakoOptions;

  constructor(options: PakoOptions = {}) {
    this.#options = options;
  }

  push(data: Data, mode?: boolean | number): boolean {
    if (this.result !== undefined) return true;

    const chunk = toBytes(data);
    if (chunk.length > 0) this.#chunks.push(chunk);
    const input = concat(this.#chunks);

    try {
      const out = (this.#options.raw
        ? zlib.inflateRawSync(input, { ...toZlibOptions(this.#options), info: true })
        : zlib.inflateSync(input, {
            ...toZlibOptions(this.#options),
            info: true,
          })) as unknown as ZlibInfoResult;
      this.result = normalizeOutput(out.buffer, this.#options);
      const consumed = out.engine?.bytesWritten ?? input.length;
      this.strm.avail_in = Math.max(0, input.length - consumed);
      this.err = 0;
      this.msg = "";
      return true;
    } catch (cause) {
      const error = cause as ZlibError;
      if (!mode && isIncompleteInput(error)) return true;
      this.err = pakoErrno(error);
      this.msg = error.message;
      return false;
    }
  }
}

export class Deflate {
  err = 0;
  msg = "";
  result: Uint8Array | string | undefined;
  readonly strm: PakoStream = { avail_in: 0 };

  readonly #chunks: Uint8Array[] = [];
  readonly #options: PakoOptions;

  constructor(options: PakoOptions = {}) {
    this.#options = options;
  }

  push(data: Data, mode?: boolean | number): boolean {
    if (this.result !== undefined) return true;

    const chunk = toBytes(data);
    if (chunk.length > 0) this.#chunks.push(chunk);
    if (!mode) return true;

    try {
      this.result = deflate(concat(this.#chunks), this.#options);
      this.err = 0;
      this.msg = "";
      this.strm.avail_in = 0;
      return true;
    } catch (cause) {
      const error = cause as ZlibError;
      this.err = pakoErrno(error);
      this.msg = error.message;
      return false;
    }
  }
}

const pako = {
  Deflate,
  deflate,
  deflateRaw,
  gzip,
  Inflate,
  inflate,
  inflateRaw,
  ungzip,
  ...zlib.constants,
};

export const {
  Z_NO_FLUSH,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  Z_FULL_FLUSH,
  Z_FINISH,
  Z_BLOCK,
  Z_OK,
  Z_STREAM_END,
  Z_NEED_DICT,
  Z_ERRNO,
  Z_STREAM_ERROR,
  Z_DATA_ERROR,
  Z_MEM_ERROR,
  Z_BUF_ERROR,
  Z_VERSION_ERROR,
} = zlib.constants;

export default pako;
