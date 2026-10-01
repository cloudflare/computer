import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding } from "../shell.js";
import { type CommandOutputFiles, OutputSpool, type SpooledOutput } from "./output-spool.js";
import { makeOutputLimits, type OutputLimits } from "./output-tail.js";
import type {
  ModuleExecutionEnvelope,
  WorkspaceModuleBackendHandle,
  WorkspaceRuntimeDisposeOptions,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions,
  WorkspaceRuntimeResult,
} from "./types.js";

interface WorkspaceRuntimeRouterOptions {
  // What each registered backend says about itself.
  backends: ReadonlyMap<string, { readonly callable?: boolean; readonly description?: string }>;
  backendHandle: (id: string) => Promise<WorkspaceModuleBackendHandle>;
  resolveBackendId: (id: string | undefined) => string;
  // Where output too long for a result is saved, and the default
  // limits. Absent when the Workspace turned saving off.
  output?: { readonly files: CommandOutputFiles; readonly limits: OutputLimits };
}

// Fresh spools for one pass over an execution's events.
type OutputSpools = () => { readonly stdout: OutputSpool; readonly stderr: OutputSpool };

// The error a caller sees when it hands structured `input` to a
// backend that does not accept it. Exported so the exec tool rejects
// with the same wording the runtime raises, instead of a second copy
// that could drift.
export function notCallableMessage(backend: string): string {
  return `Backend ${JSON.stringify(backend)} is not callable; it does not accept structured input.`;
}

export class WorkspaceRuntime {
  readonly #options: WorkspaceRuntimeRouterOptions;

  constructor(options: WorkspaceRuntimeRouterOptions) {
    this.#options = options;
  }

  // Whether the named backend accepts a structured `input` value and
  // returns a structured result. Consumers such as the exec tool ask
  // this to know whether a backend is callable without the caller
  // having to declare it a second time.
  isCallable(id: string): boolean {
    return this.#options.backends.get(id)?.callable === true;
  }

  // Every registered backend id, in registration order. The first is
  // the default. The exec tool uses this when the caller does not pick
  // backends itself.
  backendIds(): string[] {
    return [...this.#options.backends.keys()];
  }

  // What the named backend says about itself for a model: its source
  // language and, for the JavaScript backend, the modules code can
  // import. The exec tool adds it to the backend's entry so a caller
  // does not have to repeat it.
  describe(id: string): string | undefined {
    return this.#options.backends.get(id)?.description;
  }

  exec(source: string): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<"utf8">,
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<undefined>,
  ): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  async exec<E extends ExecEncoding>(
    source: string,
    options: WorkspaceRuntimeExecOptions<E> = {},
  ): Promise<WorkspaceRuntimeExecHandle<E>> {
    if (options.id !== undefined) assertExecutionId(options.id);
    const backend = this.#backend(options.backend);
    if (options.input !== undefined && !this.isCallable(backend)) {
      throw new Error(notCallableMessage(backend));
    }
    const runtime = await this.#options.backendHandle(backend);
    const envelope = await runtime.exec({
      id: options.id,
      source,
      cwd: options.cwd,
      input: options.input,
      env: options.env,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      sync: options.sync,
    });
    return wrapModuleHandle(
      runtime,
      backend,
      envelope.id,
      envelope.events,
      options.encoding,
      true,
      envelope.sync,
      envelope.runtimeId,
      this.#outputSpools(backend, envelope.id, options.output),
    );
  }

  getExec(id: string): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<"utf8">,
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<undefined>,
  ): Promise<WorkspaceRuntimeExecHandle<undefined>>;
  async getExec<E extends ExecEncoding>(
    id: string,
    options: WorkspaceRuntimeGetOptions<E> = {},
  ): Promise<WorkspaceRuntimeExecHandle<E>> {
    assertExecutionId(id);
    const backend = this.#backend(options.backend);
    const runtime = await this.#options.backendHandle(backend);
    const envelope = await runtime.getExec({ id, after: resumeToAfter(options.resume) });
    const full = options.resume === undefined || options.resume === "full";
    return wrapModuleHandle(
      runtime,
      backend,
      envelope.id,
      envelope.events,
      options.encoding,
      full,
      envelope.sync,
      envelope.runtimeId,
      // Only a replay from the start sees all the output to save. A
      // partial replay still cuts `result()` by the same limits, since
      // it falls back to a full replay.
      this.#outputSpools(backend, envelope.id, options.output),
    );
  }

  async killExec(id: string, options: WorkspaceRuntimeKillOptions = {}): Promise<void> {
    assertExecutionId(id);
    const backend = this.#backend(options.backend);
    await (await this.#options.backendHandle(backend)).killExec({ id, signal: options.signal });
  }

  async disposeExec(id: string, options: WorkspaceRuntimeDisposeOptions = {}): Promise<void> {
    assertExecutionId(id);
    const backend = this.#backend(options.backend);
    await (await this.#options.backendHandle(backend)).disposeExec({ id });
  }

  // Spools that cut each stream to the limits and save the full output
  // under a name unique to the backend and execution. Undefined when
  // saving is off for the Workspace or this call.
  #outputSpools(
    backend: string,
    id: string,
    requested: WorkspaceRuntimeExecOptions["output"],
  ): OutputSpools | undefined {
    const output = this.#options.output;
    if (output === undefined || requested === false) return undefined;
    const limits =
      requested === undefined
        ? output.limits
        : makeOutputLimits(
            {
              maxLines: requested.maxLines ?? output.limits.maxLines,
              maxBytes: requested.maxBytes ?? output.limits.maxBytes,
            },
            "runtime.exec output",
          );
    const name = `${fileNamePart(backend)}.${fileNamePart(id)}`;
    return () => ({
      stdout: new OutputSpool(limits, output.files, `${name}.stdout.log`),
      stderr: new OutputSpool(limits, output.files, `${name}.stderr.log`),
    });
  }

  #backend(requested: string | undefined): string {
    const backend = this.#options.resolveBackendId(requested);
    if (!backend) {
      throw new Error(
        "Workspace has no execution backend configured. Pass `backends` to the Workspace constructor.",
      );
    }
    return backend;
  }
}

function wrapModuleHandle<E extends ExecEncoding>(
  runtime: WorkspaceModuleBackendHandle,
  backend: string,
  id: string,
  source: ReadableStream<WorkspaceRuntimeEvent>,
  encoding: E | undefined,
  resultMayUseSource = true,
  sync?: ModuleExecutionEnvelope["sync"],
  runtimeId?: string,
  spools?: OutputSpools,
): WorkspaceRuntimeExecHandle<E> {
  let claimed: "result" | "stream" | undefined;
  let sourceCancelled = false;
  let reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<E>> | undefined;
  let resultReader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent> | undefined;
  let resultPromise: Promise<WorkspaceRuntimeResult<E>> | undefined;
  const stream = new ReadableStream<WorkspaceRuntimeEvent<E>>(
    {
      async pull(controller) {
        if (claimed === "result") {
          controller.error(new Error("runtime handle already consumed by result()"));
          return;
        }
        claimed = "stream";
        if (reader === undefined) {
          // A partial replay misses the start of the output, so it is
          // streamed as is rather than saved over a full copy.
          const events =
            spools !== undefined && resultMayUseSource ? spoolEvents(source, spools()) : source;
          reader = transformModuleEvents(events, encoding).getReader();
        }
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            reader = undefined;
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          reader?.releaseLock();
          reader = undefined;
          controller.error(error);
        }
      },
      async cancel(reason) {
        sourceCancelled = true;
        if (reader) {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
            reader = undefined;
          }
        } else await source.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  ) as WorkspaceRuntimeExecHandle<E>;
  Object.defineProperties(stream, {
    id: { value: id, enumerable: false },
    backend: { value: backend, enumerable: false },
    result: {
      value: (): Promise<WorkspaceRuntimeResult<E>> => {
        if (claimed === "stream") {
          throw new Error("runtime handle already streaming: result() and streaming are exclusive");
        }
        claimed = "result";
        resultPromise ??= (async () => {
          const setReader = (
            active: ReadableStreamDefaultReader<WorkspaceRuntimeEvent> | undefined,
          ) => {
            resultReader = active;
          };
          if (resultMayUseSource && !sourceCancelled) {
            return drainModuleResult<E>(source, encoding, setReader, sync, spools?.());
          }
          if (!sourceCancelled) await source.cancel("result() requested a full replay");
          const replay = await runtime.getExec({ id, runtimeId });
          return drainModuleResult<E>(replay.events, encoding, setReader, replay.sync, spools?.());
        })();
        return resultPromise;
      },
    },
    kill: {
      value: (signal?: WorkspaceRuntimeKillOptions["signal"]) =>
        runtime.killExec({ id, signal, runtimeId }),
    },
    [Symbol.dispose]: {
      value: () => {
        if (resultReader) void resultReader.cancel().catch(() => undefined);
        else void stream.cancel().catch(() => undefined);
      },
    },
  });
  return stream;
}

function transformModuleEvents<E extends ExecEncoding>(
  source: ReadableStream<WorkspaceRuntimeEvent>,
  encoding: E | undefined,
): ReadableStream<WorkspaceRuntimeEvent<E>> {
  if (encoding !== "utf8") {
    return source as ReadableStream<WorkspaceRuntimeEvent<E>>;
  }
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let stdoutMeta: { id: string; seq: number } | undefined;
  let stderrMeta: { id: string; seq: number } | undefined;
  let lastSeq = 0;
  const enqueue = (
    controller: TransformStreamDefaultController<WorkspaceRuntimeEvent<E>>,
    event: WorkspaceRuntimeEvent<E>,
  ) => {
    lastSeq = event.seq;
    controller.enqueue(event);
  };
  const flushPending = (
    controller: TransformStreamDefaultController<WorkspaceRuntimeEvent<E>>,
    beforeSeq?: number,
  ) => {
    const pending: WorkspaceRuntimeEvent<E>[] = [];
    const stdout = stdoutDecoder.decode();
    const stderr = stderrDecoder.decode();
    if (stdout && stdoutMeta) {
      pending.push({
        ...stdoutMeta,
        name: "stdout",
        value: stdout,
      } as WorkspaceRuntimeEvent<E>);
    }
    if (stderr && stderrMeta) {
      pending.push({
        ...stderrMeta,
        name: "stderr",
        value: stderr,
      } as WorkspaceRuntimeEvent<E>);
    }
    pending.sort((a, b) => a.seq - b.seq);
    const span = beforeSeq !== undefined && beforeSeq > lastSeq ? beforeSeq - lastSeq : 1;
    let index = 0;
    for (const event of pending) {
      index += 1;
      enqueue(controller, {
        ...event,
        seq: lastSeq + (span * index) / (pending.length + 1),
      } as WorkspaceRuntimeEvent<E>);
    }
    stdoutMeta = undefined;
    stderrMeta = undefined;
  };
  return source.pipeThrough(
    new TransformStream<WorkspaceRuntimeEvent, WorkspaceRuntimeEvent<E>>({
      transform(event, controller) {
        if (event.name === "stdout" || event.name === "stderr") {
          if (event.name === "stdout") stdoutMeta = { id: event.id, seq: event.seq };
          else stderrMeta = { id: event.id, seq: event.seq };
          enqueue(controller, {
            ...event,
            value: (event.name === "stdout" ? stdoutDecoder : stderrDecoder).decode(event.value, {
              stream: true,
            }),
          } as WorkspaceRuntimeEvent<E>);
        } else {
          // `exit` is the only non-stdio event; flush any buffered
          // partial output before the terminal event so a trailing
          // multi-byte remainder lands ahead of it.
          flushPending(controller, event.seq);
          enqueue(controller, event as WorkspaceRuntimeEvent<E>);
        }
      },
      flush: flushPending,
    }),
  );
}

async function drainModuleResult<E extends ExecEncoding>(
  events: ReadableStream<WorkspaceRuntimeEvent>,
  encoding: E | undefined,
  setReader: (reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent> | undefined) => void,
  sync?: ModuleExecutionEnvelope["sync"],
  spools?: ReturnType<OutputSpools>,
): Promise<WorkspaceRuntimeResult<E>> {
  // With spools, output goes through them and only the end is kept;
  // without, every chunk is kept.
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const collect = async (
    spool: OutputSpool | undefined,
    chunks: Uint8Array[],
    chunk: Uint8Array,
  ) => {
    if (spool === undefined) chunks.push(chunk);
    else await spool.push(chunk);
  };
  let value: WorkspaceRuntimeResult<E>["value"];
  // -1 marks a stream that closed without an exit frame, keeping that
  // case distinct from a genuine exit 1. Both settle as "failed".
  let exitCode = -1;
  const reader = events.getReader();
  setReader(reader);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (event.name === "stdout") await collect(spools?.stdout, stdout, event.value);
      if (event.name === "stderr") await collect(spools?.stderr, stderr, event.value);
      if (event.name === "exit") {
        exitCode = event.code;
        if ("result" in event) value = event.result;
      }
    }
  } catch (error) {
    // Close any output file so its writer does not wait forever.
    await Promise.all([spools?.stdout.finish(), spools?.stderr.finish()]);
    throw error;
  } finally {
    reader.releaseLock();
    setReader(undefined);
  }
  const [out, err] = await Promise.all([
    spools?.stdout.finish() ?? { bytes: joinBytes(stdout) },
    spools?.stderr.finish() ?? { bytes: joinBytes(stderr) },
  ]);
  const truncated = truncation(out, err);
  // A backend with a remote store reports its sync bracket stats;
  // the pull outcome settles once the event stream above drains.
  const pull = sync ? await sync.outcome : undefined;
  return {
    status:
      exitCode === 0 ? "completed" : isCancellationExitCode(exitCode) ? "cancelled" : "failed",
    exitCode,
    stdout: decode(out.bytes, encoding) as WorkspaceRuntimeResult<E>["stdout"],
    stderr: decode(err.bytes, encoding) as WorkspaceRuntimeResult<E>["stderr"],
    ...(value === undefined ? {} : { value }),
    ...(truncated === undefined ? {} : { truncated }),
    pushed: sync?.pushed ?? 0,
    pulled: pull?.applied ?? 0,
    skipped: pull?.skipped ?? ([] as SkippedEntry[]),
    sync: pull?.sync ?? { status: "complete", applied: 0, skipped: [] },
  };
}

function isCancellationExitCode(exitCode: number) {
  return exitCode === 129 || exitCode === 130 || exitCode === 137 || exitCode === 143;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decode(bytes: Uint8Array, encoding: ExecEncoding): string | Uint8Array {
  return encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes;
}

// What a result or exit event says about the streams that were cut.
function truncation(
  stdout: SpooledOutput,
  stderr: SpooledOutput,
): WorkspaceRuntimeResult["truncated"] | undefined {
  if (stdout.truncated === undefined && stderr.truncated === undefined) return undefined;
  return {
    ...(stdout.truncated === undefined ? {} : { stdout: stdout.truncated }),
    ...(stderr.truncated === undefined ? {} : { stderr: stderr.truncated }),
  };
}

// Pass events through unchanged while feeding output into the spools.
// The exit event waits for the spools to finish, so it can say where
// any cut output was saved before the caller sees the run end. A
// caller that stops early still closes the files.
function spoolEvents(
  source: ReadableStream<WorkspaceRuntimeEvent>,
  spools: ReturnType<OutputSpools>,
): ReadableStream<WorkspaceRuntimeEvent> {
  const finish = async () => {
    const [stdout, stderr] = await Promise.all([spools.stdout.finish(), spools.stderr.finish()]);
    return truncation(stdout, stderr);
  };
  const reader = source.getReader();
  return new ReadableStream<WorkspaceRuntimeEvent>(
    {
      async pull(controller) {
        let next: ReadableStreamReadResult<WorkspaceRuntimeEvent>;
        try {
          next = await reader.read();
        } catch (error) {
          await finish();
          controller.error(error);
          return;
        }
        if (next.done) {
          await finish();
          controller.close();
          return;
        }
        const event = next.value;
        if (event.name === "stdout") await spools.stdout.push(event.value);
        else if (event.name === "stderr") await spools.stderr.push(event.value);
        else {
          const truncated = await finish();
          controller.enqueue(truncated === undefined ? event : { ...event, truncated });
          return;
        }
        controller.enqueue(event);
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await finish();
      },
    },
    { highWaterMark: 0 },
  );
}

// One part of an output file name. `.` separates the parts, so it is
// escaped along with anything a path cannot hold.
function fileNamePart(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

function assertExecutionId(id: string) {
  if (id.length === 0) throw new Error("Workspace runtime execution id must not be empty.");
  if (new TextEncoder().encode(id).byteLength > 256) {
    throw new Error("Workspace runtime execution id exceeds 256 bytes.");
  }
}

function resumeToAfter(resume: "tail" | "full" | number | undefined) {
  if (resume === "tail") return "tail" as const;
  if (typeof resume === "number") return resume;
  return undefined;
}
