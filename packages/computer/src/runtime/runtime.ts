import type { SkippedEntry } from "@cloudflare/dofs";

import type { ExecEncoding, ExecHandle, WorkspaceShell } from "../shell.js";
import type {
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
  commandBackendIds: ReadonlySet<string>;
  shell: () => WorkspaceShell;
  moduleHandle: (id: string) => Promise<WorkspaceModuleBackendHandle>;
  resolveBackendId: (id: string | undefined) => string;
}

export class WorkspaceRuntime {
  readonly #options: WorkspaceRuntimeRouterOptions;

  constructor(options: WorkspaceRuntimeRouterOptions) {
    this.#options = options;
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
    if (this.#options.commandBackendIds.has(backend)) {
      if (options.input !== undefined) {
        throw new Error(`Backend ${JSON.stringify(backend)} does not accept structured input.`);
      }
      const shell = this.#options.shell();
      const handle = await (
        shell.exec as unknown as (
          command: string,
          options: Record<string, unknown>,
        ) => Promise<ExecHandle<E>>
      )(source, {
        backend,
        cwd: options.cwd,
        encoding: options.encoding,
        id: options.id,
        timeoutMs: options.timeoutMs,
      });
      return wrapCommandHandle(handle, backend);
    }

    const runtime = await this.#options.moduleHandle(backend);
    const envelope = await runtime.exec({
      id: options.id,
      source,
      cwd: options.cwd,
      input: options.input,
      timeoutMs: options.timeoutMs,
    });
    return wrapModuleHandle(runtime, backend, envelope.id, envelope.events, options.encoding);
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
    if (this.#options.commandBackendIds.has(backend)) {
      const shell = this.#options.shell();
      const handle = await (
        shell.get as unknown as (
          id: string,
          options: Record<string, unknown>,
        ) => Promise<ExecHandle<E>>
      )(id, {
        backend,
        encoding: options.encoding,
        resume: options.resume,
      });
      const resultHandle =
        options.resume === undefined || options.resume === "full"
          ? undefined
          : () =>
              (
                shell.get as unknown as (
                  id: string,
                  options: Record<string, unknown>,
                ) => Promise<ExecHandle<E>>
              )(id, {
                backend,
                encoding: options.encoding,
                resume: "full",
              });
      return wrapCommandHandle(handle, backend, resultHandle);
    }

    const runtime = await this.#options.moduleHandle(backend);
    const envelope = await runtime.getExec({ id, after: resumeToAfter(options.resume) });
    return wrapModuleHandle(
      runtime,
      backend,
      envelope.id,
      envelope.events,
      options.encoding,
      options.resume === undefined || options.resume === "full",
    );
  }

  async killExec(id: string, options: WorkspaceRuntimeKillOptions = {}): Promise<void> {
    assertExecutionId(id);
    const backend = this.#backend(options.backend);
    if (this.#options.commandBackendIds.has(backend)) {
      await this.#options.shell().kill(id, options.signal, { backend });
      return;
    }
    await (await this.#options.moduleHandle(backend)).killExec({ id, signal: options.signal });
  }

  async disposeExec(id: string, options: WorkspaceRuntimeDisposeOptions = {}): Promise<void> {
    assertExecutionId(id);
    const backend = this.#backend(options.backend);
    if (this.#options.commandBackendIds.has(backend)) {
      await this.#options.shell().dispose(id, { backend });
      return;
    }
    await (await this.#options.moduleHandle(backend)).disposeExec({ id });
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

function wrapCommandHandle<E extends ExecEncoding>(
  handle: ExecHandle<E>,
  backend: string,
  lazyResultHandle?: () => Promise<ExecHandle<E>>,
): WorkspaceRuntimeExecHandle<E> {
  let claimed: "result" | "stream" | undefined;
  let reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<E>> | undefined;
  let resultPromise: Promise<WorkspaceRuntimeResult<E>> | undefined;
  const stream = new ReadableStream<WorkspaceRuntimeEvent<E>>(
    {
      async pull(controller) {
        if (claimed === "result") {
          controller.error(new Error("runtime handle already consumed by result()"));
          return;
        }
        claimed = "stream";
        reader ??= handle.getReader() as ReadableStreamDefaultReader<WorkspaceRuntimeEvent<E>>;
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
        if (reader) {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
            reader = undefined;
          }
        } else await handle.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  ) as WorkspaceRuntimeExecHandle<E>;
  Object.defineProperties(stream, {
    id: { value: handle.id, enumerable: false },
    backend: { value: backend, enumerable: false },
    result: {
      value: (): Promise<WorkspaceRuntimeResult<E>> => {
        if (claimed === "stream") {
          throw new Error("runtime handle already streaming: result() and streaming are exclusive");
        }
        claimed = "result";
        resultPromise ??= (async () => {
          if (lazyResultHandle) await handle.cancel("result() requested a full replay");
          const result = lazyResultHandle
            ? await (await lazyResultHandle()).result()
            : await handle.result();
          return {
            status:
              result.exitCode === 0
                ? "completed"
                : isCancellationExitCode(result.exitCode)
                  ? "cancelled"
                  : "failed",
            ...result,
          };
        })();
        return resultPromise;
      },
    },
    kill: {
      value: (signal?: WorkspaceRuntimeKillOptions["signal"]) => handle.kill(signal),
    },
    [Symbol.dispose]: { value: () => handle[Symbol.dispose]() },
  });
  return stream;
}

function wrapModuleHandle<E extends ExecEncoding>(
  runtime: WorkspaceModuleBackendHandle,
  backend: string,
  id: string,
  source: ReadableStream<WorkspaceRuntimeEvent>,
  encoding: E | undefined,
  resultMayUseSource = true,
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
            return drainModuleResult<E>(source, encoding, setReader);
          }
          if (!sourceCancelled) await source.cancel("result() requested a full replay");
          return drainModuleResult<E>((await runtime.getExec({ id })).events, encoding, setReader);
        })();
        return resultPromise;
      },
    },
    kill: {
      value: (signal?: WorkspaceRuntimeKillOptions["signal"]) => runtime.killExec({ id, signal }),
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
  const flushPending = (controller: TransformStreamDefaultController<WorkspaceRuntimeEvent<E>>) => {
    const stdout = stdoutDecoder.decode();
    const stderr = stderrDecoder.decode();
    if (stdout && stdoutMeta) {
      controller.enqueue({
        ...stdoutMeta,
        name: "stdout",
        value: stdout,
      } as WorkspaceRuntimeEvent<E>);
    }
    if (stderr && stderrMeta) {
      controller.enqueue({
        ...stderrMeta,
        name: "stderr",
        value: stderr,
      } as WorkspaceRuntimeEvent<E>);
    }
  };
  return source.pipeThrough(
    new TransformStream<WorkspaceRuntimeEvent, WorkspaceRuntimeEvent<E>>({
      transform(event, controller) {
        if (event.name === "stdout" || event.name === "stderr") {
          if (event.name === "stdout") stdoutMeta = { id: event.id, seq: event.seq };
          else stderrMeta = { id: event.id, seq: event.seq };
          controller.enqueue({
            ...event,
            value: (event.name === "stdout" ? stdoutDecoder : stderrDecoder).decode(event.value, {
              stream: true,
            }),
          } as WorkspaceRuntimeEvent<E>);
        } else {
          if (event.name === "exit") flushPending(controller);
          controller.enqueue(event as WorkspaceRuntimeEvent<E>);
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
): Promise<WorkspaceRuntimeResult<E>> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let value: WorkspaceRuntimeResult<E>["value"];
  let exitCode = 1;
  const reader = events.getReader();
  setReader(reader);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (event.name === "stdout") stdout.push(event.value);
      if (event.name === "stderr") stderr.push(event.value);
      if (event.name === "result") value = event.value;
      if (event.name === "exit") exitCode = event.value;
    }
  } finally {
    reader.releaseLock();
    setReader(undefined);
  }
  return {
    status: exitCode === 0 ? "completed" : exitCode === 130 ? "cancelled" : "failed",
    exitCode,
    stdout: join(stdout, encoding) as WorkspaceRuntimeResult<E>["stdout"],
    stderr: join(stderr, encoding) as WorkspaceRuntimeResult<E>["stderr"],
    ...(value === undefined ? {} : { value }),
    pushed: 0,
    pulled: 0,
    skipped: [] as SkippedEntry[],
    sync: { status: "complete", applied: 0, skipped: [] },
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
