import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding } from "../shell.js";
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
  callableBackendIds: ReadonlySet<string>;
  backendHandle: (id: string) => Promise<WorkspaceModuleBackendHandle>;
  resolveBackendId: (id: string | undefined) => string;
}

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
    return this.#options.callableBackendIds.has(id);
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
    return wrapModuleHandle(
      runtime,
      backend,
      envelope.id,
      envelope.events,
      options.encoding,
      options.resume === undefined || options.resume === "full",
      envelope.sync,
      envelope.runtimeId,
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
        reader ??= transformModuleEvents(source, encoding).getReader();
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
            return drainModuleResult<E>(source, encoding, setReader, sync);
          }
          if (!sourceCancelled) await source.cancel("result() requested a full replay");
          const replay = await runtime.getExec({ id, runtimeId });
          return drainModuleResult<E>(replay.events, encoding, setReader, replay.sync);
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
): Promise<WorkspaceRuntimeResult<E>> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
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
      if (event.name === "stdout") stdout.push(event.value);
      if (event.name === "stderr") stderr.push(event.value);
      if (event.name === "exit") {
        exitCode = event.code;
        if ("result" in event) value = event.result;
      }
    }
  } finally {
    reader.releaseLock();
    setReader(undefined);
  }
  // A backend with a remote store reports its sync bracket stats;
  // the pull outcome settles once the event stream above drains.
  const pull = sync ? await sync.outcome : undefined;
  return {
    status:
      exitCode === 0 ? "completed" : isCancellationExitCode(exitCode) ? "cancelled" : "failed",
    exitCode,
    stdout: join(stdout, encoding) as WorkspaceRuntimeResult<E>["stdout"],
    stderr: join(stderr, encoding) as WorkspaceRuntimeResult<E>["stderr"],
    ...(value === undefined ? {} : { value }),
    pushed: sync?.pushed ?? 0,
    pulled: pull?.applied ?? 0,
    skipped: pull?.skipped ?? ([] as SkippedEntry[]),
    sync: pull?.sync ?? { status: "complete", applied: 0, skipped: [] },
  };
}

function isCancellationExitCode(exitCode: number) {
  return exitCode === 129 || exitCode === 130 || exitCode === 137 || exitCode === 143;
}

function join(chunks: Uint8Array[], encoding: ExecEncoding): string | Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes;
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
