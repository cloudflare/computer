/**
 * The session protocol's messages as plain TypeScript values.
 *
 * This is the only module that touches Cap'n Proto encoding. Everything the session sends is
 * treated as hostile: remote-exec runs in a container where the model's code also runs, and can be
 * replaced. So decoding validates every field before anything else sees it.
 */
import * as $ from "capnp-es";
import * as S from "./capnp/exec";

export const PROTOCOL = 1;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export type EntryKind = "file" | "symlink";

export interface Entry {
  path: string;
  kind: EntryKind;
  mode: number;
  size: number;
  hash: Uint8Array;
  target: string;
}

export interface Selection {
  root: string;
  globs: string[];
}

export interface RunSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  user: string;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface Report {
  written: number;
  bytes: number;
  deleted: string[];
  skipped: Skipped[];
}

export type Request =
  | { type: "begin"; id: string; root: string; lock: boolean; lockTimeoutMs: number }
  | { type: "push"; selection: Selection; manifest: Entry[]; owner: string }
  | { type: "chunk"; index: number; data: Uint8Array; last: boolean }
  | { type: "pushEnd" }
  | { type: "prepare"; spec: RunSpec; pull: Selection }
  | { type: "awaitStart" }
  | { type: "signal"; signal: number }
  | { type: "pull" }
  | { type: "close" };

export type Response =
  | { type: "begun"; protocol: number; version: string; arch: string; lockWaitMs: number }
  | { type: "want"; indices: number[] }
  | { type: "pushReport"; report: Report }
  | { type: "prepared"; token: Uint8Array }
  | { type: "started"; pid: number }
  | { type: "signaled" }
  | { type: "changes"; changed: Entry[]; deleted: string[]; skipped: Skipped[] }
  | { type: "chunk"; index: number; data: Uint8Array; last: boolean }
  | { type: "pullEnd"; report: Report }
  | { type: "error"; code: string; message: string; errno: number }
  | { type: "closed" };

const MAX_PATH = 4096;
const MAX_LIST = 1_000_000;
const MAX_TEXT = 64 * 1024;

/** A path relative to the sync root, as the protocol carries it. */
export function isRelPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PATH &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    path.split("/").every((c) => c !== "" && c !== "." && c !== "..")
  );
}

function text(value: string, what: string, max = MAX_TEXT): string {
  if (value.length > max) throw new ProtocolError(`${what} is too long`);
  return value;
}

function relPath(value: string, what: string): string {
  if (!isRelPath(value))
    throw new ProtocolError(
      `${what} isn't a safe relative path: ${JSON.stringify(value.slice(0, 200))}`,
    );
  return value;
}

function count(length: number, what: string): number {
  if (length > MAX_LIST) throw new ProtocolError(`${what} has ${length} items`);
  return length;
}

function bytes(data: $.Data): Uint8Array {
  return data.toUint8Array().slice();
}

function setEntry(builder: S.Entry, entry: Entry): void {
  builder.path = entry.path;
  builder.kind = entry.kind === "file" ? S.Entry_Kind.FILE : S.Entry_Kind.SYMLINK;
  builder.mode = entry.mode;
  builder.size = BigInt(entry.size);
  if (entry.hash.byteLength > 0) builder._initHash(entry.hash.byteLength).copyBuffer(entry.hash);
  builder.target = entry.target;
}

function setSelection(builder: S.Selection, selection: Selection): void {
  builder.root = selection.root;
  const globs = builder._initGlobs(selection.globs.length);
  for (const [i, g] of selection.globs.entries()) globs.set(i, g);
}

export function encodeRequest(request: Request): Uint8Array {
  const message = new $.Message();
  const root = message.initRoot(S.Request);
  switch (request.type) {
    case "begin": {
      const b = root._initBegin();
      b.id = request.id;
      b.root = request.root;
      b.lock = request.lock;
      b.lockTimeoutMs = Math.max(0, Math.min(0xffffffff, Math.floor(request.lockTimeoutMs)));
      b.protocol = PROTOCOL;
      break;
    }
    case "push": {
      const p = root._initPush();
      setSelection(p._initSelection(), request.selection);
      const list = p._initManifest(request.manifest.length);
      for (const [i, entry] of request.manifest.entries()) setEntry(list.get(i), entry);
      p.owner = request.owner;
      break;
    }
    case "chunk": {
      const c = root._initChunk();
      c.index = request.index;
      if (request.data.byteLength > 0)
        c._initData(request.data.byteLength).copyBuffer(request.data);
      c.last = request.last;
      break;
    }
    case "pushEnd":
      root.pushEnd = true;
      break;
    case "prepare": {
      const p = root._initPrepare();
      const spec = p._initSpec();
      const argv = spec._initArgv(request.spec.argv.length);
      for (const [i, a] of request.spec.argv.entries()) argv.set(i, a);
      spec.cwd = request.spec.cwd;
      const vars = Object.entries(request.spec.env);
      const env = spec._initEnv(vars.length);
      for (const [i, [name, value]] of vars.entries()) {
        const v = env.get(i);
        v.name = name;
        v.value = value;
      }
      spec.user = request.spec.user;
      setSelection(p._initPull(), request.pull);
      break;
    }
    case "awaitStart":
      root.awaitStart = true;
      break;
    case "signal":
      root.signal = request.signal;
      break;
    case "pull":
      root.pull = true;
      break;
    case "close":
      root.close = true;
      break;
  }
  return new Uint8Array(message.toArrayBuffer());
}

function readEntry(e: S.Entry): Entry {
  const kind =
    e.kind === S.Entry_Kind.FILE ? "file" : e.kind === S.Entry_Kind.SYMLINK ? "symlink" : undefined;
  if (kind === undefined) throw new ProtocolError(`unknown entry kind ${e.kind}`);
  const size = e.size;
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("entry size is too large");
  const hash = bytes(e.hash);
  if (kind === "file" && hash.byteLength !== 32)
    throw new ProtocolError("a file entry's hash must be 32 bytes");
  return {
    path: relPath(e.path, "entry path"),
    kind,
    mode: e.mode & 0o7777,
    size: Number(size),
    hash,
    target: text(e.target, "symlink target", MAX_PATH),
  };
}

function readSkipped(list: $.List<S.Skipped>): Skipped[] {
  count(list.length, "skipped");
  const out: Skipped[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list.get(i);
    out.push({
      path: text(s.path, "skipped path", MAX_PATH),
      reason: text(s.reason, "skipped reason"),
    });
  }
  return out;
}

function readPaths(list: $.List<string>, what: string): string[] {
  count(list.length, what);
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) out.push(relPath(list.get(i), what));
  return out;
}

function readReport(r: S.Report): Report {
  const bytesSent = r.bytes;
  return {
    written: r.written,
    bytes: Number(
      bytesSent > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytesSent,
    ),
    deleted: readPaths(r.deleted, "deleted path"),
    skipped: readSkipped(r.skipped),
  };
}

const MAX_SEGMENTS = 512;

/**
 * Check the segment table before capnp-es sees the message: it allocates per segment while
 * parsing the table, so a frame claiming a billion segments exhausts memory (found by fuzzing).
 * FrameReader checks this too; decoding must be safe on its own.
 */
function checkFrame(frame: Uint8Array): void {
  if (frame.byteLength < 8) throw new ProtocolError("message is too short");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segments = view.getUint32(0, true) + 1;
  if (segments > MAX_SEGMENTS) throw new ProtocolError(`message has ${segments} segments`);
  const header = 4 + 4 * segments + (segments % 2 === 0 ? 4 : 0);
  if (header > frame.byteLength) throw new ProtocolError("message ends inside its segment table");
  let total = header;
  for (let i = 0; i < segments; i++) total += view.getUint32(4 + 4 * i, true) * 8;
  if (total !== frame.byteLength)
    throw new ProtocolError(`segment table says ${total} bytes, message has ${frame.byteLength}`);
}

export function decodeResponse(frame: Uint8Array): Response {
  checkFrame(frame);
  try {
    const message = new $.Message(frame, false);
    const r = message.getRoot(S.Response);
    switch (r.which()) {
      case S.Response.BEGUN: {
        const b = r.begun;
        return {
          type: "begun",
          protocol: b.protocol,
          version: text(b.version, "version"),
          arch: text(b.arch, "arch"),
          lockWaitMs: b.lockWaitMs,
        };
      }
      case S.Response.WANT: {
        const list = r.want;
        count(list.length, "want");
        const indices: number[] = [];
        for (let i = 0; i < list.length; i++) indices.push(list.get(i));
        return { type: "want", indices };
      }
      case S.Response.PUSH_REPORT:
        return { type: "pushReport", report: readReport(r.pushReport) };
      case S.Response.PREPARED: {
        const token = bytes(r.prepared);
        if (token.byteLength !== 16) throw new ProtocolError("the token must be 16 bytes");
        return { type: "prepared", token };
      }
      case S.Response.STARTED:
        return { type: "started", pid: r.started };
      case S.Response.SIGNALED:
        return { type: "signaled" };
      case S.Response.CHANGES: {
        const c = r.changes;
        count(c.changed.length, "changed");
        const changed: Entry[] = [];
        for (let i = 0; i < c.changed.length; i++) changed.push(readEntry(c.changed.get(i)));
        return {
          type: "changes",
          changed,
          deleted: readPaths(c.deleted, "deleted path"),
          skipped: readSkipped(c.skipped),
        };
      }
      case S.Response.CHUNK: {
        const c = r.chunk;
        return { type: "chunk", index: c.index, data: bytes(c.data), last: c.last };
      }
      case S.Response.PULL_END:
        return { type: "pullEnd", report: readReport(r.pullEnd) };
      case S.Response.ERROR: {
        const e = r.error;
        return {
          type: "error",
          code: text(e.code, "error code", 64),
          message: text(e.message, "error message"),
          errno: e.errno,
        };
      }
      case S.Response.CLOSED:
        return { type: "closed" };
      default:
        throw new ProtocolError(`unknown response ${r.which()}`);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(
      `undecodable response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
