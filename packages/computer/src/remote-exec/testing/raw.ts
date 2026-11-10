/**
 * Test-only message tools that skip messages.ts's validation: encode any response (including
 * hostile ones a compromised container could send), decode requests (to play the session's part),
 * and build arbitrary requests (to send the real binary things the host never would).
 */
import * as $ from "capnp-es";
import * as S from "../capnp/exec";
import type { Entry, Report, Request, Response, Skipped } from "../messages";
import { encodeRequest } from "../messages";

type Loose<T> = { [K in keyof T]?: unknown };

function setEntry(b: S.Entry, e: Loose<Entry>): void {
  b.path = String(e.path ?? "");
  b.kind =
    e.kind === "symlink"
      ? S.Entry_Kind.SYMLINK
      : e.kind === "file" || e.kind === undefined
        ? S.Entry_Kind.FILE
        : (e.kind as never);
  b.mode = Number(e.mode ?? 0o644);
  b.size = BigInt(Number(e.size ?? 0));
  const hash = (e.hash as Uint8Array | undefined) ?? new Uint8Array(32);
  if (hash.byteLength) b._initHash(hash.byteLength).copyBuffer(hash);
  b.target = String(e.target ?? "");
}

function setSkipped(list: $.List<S.Skipped>, skipped: Skipped[]): void {
  for (const [i, s] of skipped.entries()) {
    list.get(i).path = s.path;
    list.get(i).reason = s.reason;
  }
}

function setReport(b: S.Report, r: Report): void {
  b.written = r.written;
  b.bytes = BigInt(r.bytes);
  const d = b._initDeleted(r.deleted.length);
  for (const [i, p] of r.deleted.entries()) d.set(i, p);
  setSkipped(b._initSkipped(r.skipped.length), r.skipped);
}

/** Encode a response exactly as given, valid or not. */
export function encodeResponse(r: Response | (Loose<Response> & { type: string })): Uint8Array {
  const m = new $.Message();
  const root = m.initRoot(S.Response);
  const v = r as Record<string, unknown>;
  switch (r.type) {
    case "begun": {
      const b = root._initBegun();
      b.protocol = Number(v.protocol ?? 1);
      b.version = String(v.version ?? "remote-exec test");
      b.arch = String(v.arch ?? "x86_64");
      b.lockWaitMs = Number(v.lockWaitMs ?? 0);
      break;
    }
    case "want": {
      const indices = v.indices as number[];
      const l = root._initWant(indices.length);
      for (const [i, n] of indices.entries()) l.set(i, n);
      break;
    }
    case "pushReport":
      setReport(root._initPushReport(), v.report as Report);
      break;
    case "prepared": {
      const token = v.token as Uint8Array;
      root._initPrepared(token.byteLength).copyBuffer(token);
      break;
    }
    case "started":
      root.started = Number(v.pid);
      break;
    case "signaled":
      root.signaled = true;
      break;
    case "changes": {
      const c = root._initChanges();
      const changed = v.changed as Loose<Entry>[];
      const l = c._initChanged(changed.length);
      for (const [i, e] of changed.entries()) setEntry(l.get(i), e);
      const deleted = v.deleted as string[];
      const d = c._initDeleted(deleted.length);
      for (const [i, p] of deleted.entries()) d.set(i, p);
      setSkipped(
        c._initSkipped(((v.skipped as Skipped[]) ?? []).length),
        (v.skipped as Skipped[]) ?? [],
      );
      break;
    }
    case "chunk": {
      const c = root._initChunk();
      c.index = Number(v.index);
      const data = v.data as Uint8Array;
      if (data.byteLength) c._initData(data.byteLength).copyBuffer(data);
      c.last = Boolean(v.last);
      break;
    }
    case "pullEnd":
      setReport(root._initPullEnd(), v.report as Report);
      break;
    case "error": {
      const e = root._initError();
      e.code = String(v.code);
      e.message = String(v.message ?? "");
      e.errno = Number(v.errno ?? 0);
      break;
    }
    case "closed":
      root.closed = true;
      break;
    default:
      throw new Error(`unknown response ${r.type}`);
  }
  return new Uint8Array(m.toArrayBuffer());
}

/** Decode a request, for a fake session. Only the fields the tests look at. */
export function decodeRequest(frame: Uint8Array): Request {
  const r = new $.Message(frame, false).getRoot(S.Request);
  const list = (l: $.List<string>) => Array.from({ length: l.length }, (_, i) => l.get(i));
  switch (r.which()) {
    case S.Request.BEGIN: {
      const b = r.begin;
      return {
        type: "begin",
        id: b.id,
        root: b.root,
        lock: b.lock,
        lockTimeoutMs: b.lockTimeoutMs,
      };
    }
    case S.Request.PUSH: {
      const p = r.push;
      const manifest: Entry[] = Array.from({ length: p.manifest.length }, (_, i) => {
        const e = p.manifest.get(i);
        return {
          path: e.path,
          kind: e.kind === S.Entry_Kind.FILE ? "file" : "symlink",
          mode: e.mode,
          size: Number(e.size),
          hash: e.hash.toUint8Array().slice(),
          target: e.target,
        };
      });
      return {
        type: "push",
        selection: { root: p.selection.root, globs: list(p.selection.globs) },
        manifest,
        owner: p.owner,
        ...(p.keep.length ? { keep: list(p.keep) } : {}),
      };
    }
    case S.Request.CHUNK:
      return {
        type: "chunk",
        index: r.chunk.index,
        data: r.chunk.data.toUint8Array().slice(),
        last: r.chunk.last,
      };
    case S.Request.PUSH_END:
      return { type: "pushEnd" };
    case S.Request.PREPARE: {
      const p = r.prepare;
      const env: Record<string, string> = {};
      for (let i = 0; i < p.spec.env.length; i++)
        env[p.spec.env.get(i).name] = p.spec.env.get(i).value;
      return {
        type: "prepare",
        spec: { argv: list(p.spec.argv), cwd: p.spec.cwd, env, user: p.spec.user },
        pull: { root: p.pull.root, globs: list(p.pull.globs) },
      };
    }
    case S.Request.AWAIT_START:
      return { type: "awaitStart" };
    case S.Request.SIGNAL:
      return { type: "signal", signal: r.signal };
    case S.Request.PULL:
      return { type: "pull" };
    case S.Request.CLOSE:
      return { type: "close" };
    default:
      throw new Error(`unknown request ${r.which()}`);
  }
}

/** A Begin with any protocol number (encodeRequest always sends ours). */
export function beginWithProtocol(id: string, root: string, protocol: number): Uint8Array {
  const m = new $.Message();
  const b = m.initRoot(S.Request)._initBegin();
  b.id = id;
  b.root = root;
  b.protocol = protocol;
  return new Uint8Array(m.toArrayBuffer());
}

export { encodeRequest };
