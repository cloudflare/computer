/**
 * The isolate-side facade: source for a module code imports as
 * "codemode:remote-exec", which turns `codemode:exec`'s primitives into an `ExecProcess` shaped
 * like `ctx.container.exec()`'s.
 *
 * Streams are lazy: nothing is polled unless code reads `stdout` or `stderr`, so a call that only
 * uses `exitCode` costs two host calls (`spawn`, `wait`), and one that uses `output()` three, the
 * third cancelling the streams. Output stays readable after the command exits, until each stream
 * is read or cancelled.
 */
export const FACADE_SPECIFIER = "codemode:remote-exec";

export const FACADE_SOURCE = String.raw`
import { spawn, write, closeStdin, read, wait, cancel, kill as killExecution, abort as abortExecution } from "codemode:exec";

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text) => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function exec(argv, options = {}) {
  const { signal, stdin, ...rest } = options ?? {};
  if (signal?.aborted) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const spawnOptions = { ...rest };
  if (typeof stdin === "string") spawnOptions.stdin = stdin;
  else if (stdin instanceof Uint8Array) spawnOptions.stdinBase64 = toBase64(stdin);
  else if (stdin === "pipe" || stdin instanceof ReadableStream) spawnOptions.stdin = "pipe";
  else if (stdin !== undefined) throw new TypeError("exec: stdin must be a ReadableStream, \"pipe\", a string or a Uint8Array");

  const { id, pid, pushed } = await spawn(argv, spawnOptions);

  let streamed = false;
  let outputTaken = false;
  let result;
  const finished = () => (result ??= wait(id));
  const stream = (which) =>
    new ReadableStream({
      async pull(controller) {
        streamed = true;
        for (;;) {
          const { data, eof } = await read(id, which, 250);
          if (data) controller.enqueue(fromBase64(data));
          if (eof) return controller.close();
          if (data) return;
        }
      },
      cancel: () => cancel(id, which),
    }, { highWaterMark: 0 }); // pull only when code reads, so output() stays possible until then
  const piped = (rest.stdout ?? "pipe") === "pipe";
  const errPiped = (rest.stderr ?? "pipe") === "pipe";
  const stdout = piped ? stream("stdout") : undefined;
  const stderr = errPiped ? stream("stderr") : undefined;

  let stdinStream;
  if (stdin === "pipe" || stdin instanceof ReadableStream) {
    const sink = new WritableStream({
      write: (chunk) => write(id, toBase64(chunk)),
      close: () => closeStdin(id),
    });
    if (stdin === "pipe") stdinStream = sink;
    else stdin.pipeTo(sink).catch(() => {});
  }

  const exitCode = finished().then((r) => r.exitCode);
  const onAbort = () => abortExecution(id).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  exitCode.finally(() => signal?.removeEventListener("abort", onAbort)).catch(() => {});

  return {
    pid,
    stdin: stdinStream,
    stdout,
    stderr,
    exitCode,
    pushed,
    pulled: finished().then((r) => r.sync.pulled),
    truncated: finished().then((r) => r.truncated),
    async output() {
      if (outputTaken || streamed) throw new TypeError("output() can only be called once, before the streams are read");
      outputTaken = true;
      const [r] = await Promise.all([finished(), stdout || stderr ? cancel(id) : undefined]);
      return {
        stdout: toBuffer(fromBase64(r.stdout)),
        stderr: toBuffer(fromBase64(r.stderr)),
        exitCode: r.exitCode,
        ...(r.truncated ? { truncated: r.truncated } : {}),
        sync: r.sync,
      };
    },
    kill(sig = 15) {
      if (!Number.isInteger(sig) || sig < 1 || sig > 64) throw new RangeError("exec: signal must be 1 to 64");
      killExecution(id, sig).catch(() => {});
    },
  };
}
`;
