/**
 * A target whose `remote-exec session` is a script, to test how the host copes with a session
 * that misbehaves: the container is untrusted, so a compromised binary can send anything.
 */
import { FrameReader } from "../framing";
import type { Request, Response } from "../messages";
import type { ExecTarget, ExecTargetOptions, ExecTargetProcess } from "../target";
import { decodeRequest, encodeResponse } from "./raw";

export interface SessionScript {
  /** The next request the host sent; undefined once it closed stdin. */
  next(): Promise<Request | undefined>;
  /** Send a response (validated or not). */
  send(response: Response | ({ type: string } & Record<string, unknown>)): Promise<void>;
  sendRaw(bytes: Uint8Array): Promise<void>;
  /** End the session's stdout, as if it crashed. */
  end(): Promise<void>;
}

export interface RunBehaviour {
  stdout?: string;
  exitCode?: number;
  /** The command's exit code can't be read, as when the connection to the container breaks. */
  exitError?: Error;
}

export class FakeSessionTarget implements ExecTarget {
  readonly requests: Request[] = [];
  readonly commands: string[][] = [];
  sessionDone: Promise<void> = Promise.resolve();
  stdinClosed = false;

  constructor(
    private readonly script: (s: SessionScript) => Promise<void>,
    private readonly run: RunBehaviour = {},
  ) {}

  async exec(cmd: string[], _options?: ExecTargetOptions): Promise<ExecTargetProcess> {
    this.commands.push(cmd);
    if (cmd[1] === "session") return this.#session();
    // `remote-exec run`: the command's stdio, as a plain process.
    return {
      pid: 99,
      stdin: undefined,
      stdout: new Blob([this.run.stdout ?? ""]).stream(),
      stderr: new Blob([""]).stream(),
      exitCode:
        this.run.exitError === undefined
          ? Promise.resolve(this.run.exitCode ?? 0)
          : Promise.reject(this.run.exitError),
      kill: () => undefined,
    };
  }

  #session(): ExecTargetProcess {
    const toHost = new TransformStream<Uint8Array, Uint8Array>();
    const fromHost = new TransformStream<Uint8Array, Uint8Array>();
    const writer = toHost.writable.getWriter();
    const reader = new FrameReader(fromHost.readable);
    let resolveExit!: (code: number) => void;
    const exitCode = new Promise<number>((r) => (resolveExit = r));
    const script: SessionScript = {
      next: async () => {
        const frame = await reader.next().catch(() => undefined);
        if (frame === undefined) {
          this.stdinClosed = true;
          return undefined;
        }
        const request = decodeRequest(frame);
        this.requests.push(request);
        return request;
      },
      send: (r) => writer.write(encodeResponse(r as Response)),
      sendRaw: (bytes) => writer.write(bytes),
      end: () => writer.close().catch(() => undefined),
    };
    this.sessionDone = (async () => {
      try {
        await this.script(script);
      } catch {
        // A script that throws is a session that crashed.
      } finally {
        await writer.close().catch(() => undefined);
        resolveExit(0);
      }
    })();
    return {
      pid: 98,
      stdin: fromHost.writable,
      stdout: toHost.readable,
      stderr: new Blob(['{"remote-exec":"fake","detail":"scripted session"}\n']).stream(),
      exitCode,
      kill: () => undefined,
    };
  }
}

const TOKEN = new Uint8Array(16).fill(7);

/** Answer the usual opening (begin, push if any, prepare, awaitStart) correctly. */
export async function openNormally(
  s: SessionScript,
  want: (manifestLength: number) => number[] = () => [],
): Promise<void> {
  for (;;) {
    const r = await s.next();
    if (r === undefined) return;
    switch (r.type) {
      case "begin":
        await s.send({
          type: "begun",
          protocol: 1,
          version: "fake",
          arch: "x86_64",
          lockWaitMs: 0,
        });
        break;
      case "push":
        await s.send({ type: "want", indices: want(r.manifest.length) });
        break;
      case "chunk":
        break;
      case "pushEnd":
        await s.send({
          type: "pushReport",
          report: { written: 0, bytes: 0, deleted: [], skipped: [] },
        });
        break;
      case "prepare":
        await s.send({ type: "prepared", token: TOKEN });
        break;
      case "awaitStart":
        await s.send({ type: "started", pid: 1234 });
        return;
      default:
        throw new Error(`unexpected ${r.type}`);
    }
  }
}

/** Wait for the host's next request, which must be `type`. */
export async function expectRequest(s: SessionScript, type: Request["type"]): Promise<Request> {
  const r = await s.next();
  if (r?.type !== type) throw new Error(`expected ${type}, got ${r?.type}`);
  return r;
}
