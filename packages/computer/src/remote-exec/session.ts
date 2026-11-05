/**
 * The host's side of `remote-exec session` (exec #1): framed requests to its stdin, framed responses
 * from its stdout, strictly in order. Its stderr is the session's log.
 */
import { FrameReader } from "./framing";
import { decodeResponse, encodeRequest, type Request, type Response } from "./messages";
import { startProcess, type ExecTarget, type ResolvedProcess } from "./target";

export class RemoteExecError extends Error {
  override name = "RemoteExecError";
  constructor(
    readonly code: string,
    message: string,
    readonly errno = 0,
  ) {
    super(message);
  }
}

type ResponseOf<T extends Response["type"]> = Extract<Response, { type: T }>;

const MAX_LOG_LINES = 200;

export class SessionClient {
  readonly #process: ResolvedProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: FrameReader;
  /** Serialises request/response exchanges: one reply in flight at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly logs: string[] = [];

  private constructor(process: ResolvedProcess) {
    if (!process.stdin || !process.stdout)
      throw new RemoteExecError("target", "the target didn't pipe the session's stdio");
    this.#process = process;
    this.#writer = process.stdin.getWriter();
    this.#reader = new FrameReader(process.stdout);
    if (process.stderr) void this.#collectLogs(process.stderr);
  }

  static async start(target: ExecTarget, agentPath: string, id: string): Promise<SessionClient> {
    const process = await startProcess(target, [agentPath, "session", "--id", id], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new SessionClient(process);
  }

  get exitCode(): Promise<number> {
    return this.#process.exitCode;
  }

  /** Send a request with no reply (push chunks). */
  async send(request: Request): Promise<void> {
    await this.#writer.write(encodeRequest(request));
  }

  /** Read the next response; an `error` response throws. */
  async next(): Promise<Response> {
    const frame = await this.#reader.next();
    if (frame === undefined) {
      const tail = this.logs.slice(-5).join("\n");
      throw new RemoteExecError(
        "session",
        `the session ended unexpectedly${tail ? `:\n${tail}` : ""}`,
      );
    }
    const response = decodeResponse(frame);
    if (response.type === "error")
      throw new RemoteExecError(response.code, response.message, response.errno);
    return response;
  }

  async expect<T extends Response["type"]>(type: T): Promise<ResponseOf<T>> {
    const response = await this.next();
    if (response.type !== type)
      throw new RemoteExecError("protocol", `expected ${type}, got ${response.type}`);
    return response as ResponseOf<T>;
  }

  exclusive<T>(exchange: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(exchange, exchange);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  request<T extends Response["type"]>(request: Request, reply: T): Promise<ResponseOf<T>> {
    return this.exclusive(async () => {
      await this.send(request);
      return this.expect(reply);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.request({ type: "close" }, "closed");
    } finally {
      this.abort();
    }
  }

  /**
   * Close the session's stdin. The session treats that as "the host is gone": it kills the
   * command and everything it started, removes its socket and exits.
   */
  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#writer.close().catch(() => undefined);
    void this.#reader.cancel().catch(() => undefined);
  }

  async #collectLogs(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let partial = "";
    try {
      for await (const chunk of stream) {
        partial += decoder.decode(chunk, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line) this.logs.push(line);
          if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
        }
      }
    } catch {
      // The session went away; its logs end here.
    }
  }
}
