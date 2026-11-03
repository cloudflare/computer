import { RpcTarget } from "cloudflare:workers";
import { deserialize, serialize } from "capnweb";

import { utf8ByteLength, utf8Prefix } from "../text-truncation";
import { assertRuntimeValue, type WorkspaceRuntimeCapability } from "./capability";
import {
  type CodemodeModuleDefinition,
  codemodeObjectInfo,
  type WorkspaceModuleScopeEnd,
} from "./codemode-module";
import { isUnsafeToRepeat } from "./replay-safety";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleExecution,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeValue,
} from "./types";

/** A codemode module as the bridge runs it: its definition and its connection context. */
export interface CodemodeModuleRuntime {
  readonly definition: CodemodeModuleDefinition;
  /** Each connection context's value, made when the backend connected. */
  readonly connection: ReadonlyMap<string, unknown>;
}

/**
 * Where a defined object sits in a result: an object with this one key,
 * whose value is the object's index in the response's `objects`. The key
 * starts with a NUL so it can't be mistaken for data.
 */
export const CODEMODE_OBJECT_MARKER = "\u0000codemode";

/** A defined object in a response. The journal keeps its state; the isolate doesn't see it. */
export interface CodemodeObjectDescriptor {
  readonly ref: string;
  readonly kind: string;
  readonly state?: unknown;
}

const REPLAYABLE_LIVE_VALUE =
  "Callbacks, streams and stubs can't be passed to a host module in a replayable run.";
const REPLAYABLE_RESULT =
  "Host module values in a replayable run must be serializable. Streams, callbacks and live stubs only work in runs that don't replay.";

// A codemode call's result, with the objects found in it.
class CodemodeResult {
  constructor(
    readonly value: unknown,
    readonly objects: readonly CodemodeObjectDescriptor[],
  ) {}
}

export class WorkspaceRuntimeBridge extends RpcTarget {
  readonly #capability: WorkspaceRuntimeCapability;
  readonly #codemode: ReadonlyMap<string, CodemodeModuleRuntime>;
  readonly #scopedContext?: (
    specifier: string,
    name: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly #trackDisposable?: (
    key: string,
    close: (end: WorkspaceModuleScopeEnd) => Promise<void>,
  ) => void;
  readonly #untrackDisposable?: (key: string) => void;
  // Every object ref this scope issued or replayed, with what rebuilds it.
  readonly #known = new Map<string, { kind: string; state: unknown }>();
  // Objects built in this scope, by ref.
  readonly #live = new Map<string, object>();
  // Numbers refs in a run without a journal.
  #refCounter = 0;
  readonly #hostModules: ReadonlyMap<string, WorkspaceModuleFunctions>;
  // Aborts when the scope is cancelled or drained, for scoped context
  // starts, which the scope's calls share.
  readonly #scope = new AbortController();
  readonly #maxPayloadBytes: number;
  readonly #maxCallDurationMs: number;
  readonly #maxConcurrentCalls: number;
  readonly #maxCalls: number;
  readonly #maxTotalRequestBytes: number;
  readonly #maxTotalResponseBytes: number;
  readonly #maxResultBytes: number;
  readonly #onAttachOutput?: (readable: ReadableStream<Uint8Array>) => Promise<void>;
  readonly #journal?: BridgeJournal;
  readonly #fetch?: (request: Request) => Promise<Response>;
  readonly #execution: WorkspaceModuleExecution;
  readonly #inFlight = new Set<Promise<MeasuredResponse>>();
  #fetchesInFlight = 0;
  #fetchesRunning = 0;
  readonly #fetchQueue: Array<() => void> = [];
  readonly #abortControllers = new Set<AbortController>();
  // Responses on their way to the isolate, by their call's controller.
  readonly #responses = new Map<Promise<BridgeResponse>, AbortController>();
  // Calls that interrupted, by their controller.
  readonly #waiting = new Set<AbortController>();
  readonly #onWait?: (call: { seq: number; payload: unknown; since: number }) => void;
  // Set once a call interrupts: new calls are held, never started.
  #holding = false;
  // Wakes quiesce() when another call starts waiting.
  #waited?: () => void;
  #cancelled = false;
  #callTimedOut = false;
  #calls = 0;
  #requestBytes = 0;
  #responseBytes = 0;

  constructor(
    capability: WorkspaceRuntimeCapability,
    integrations: {
      hostModules?: ReadonlyMap<string, WorkspaceModuleFunctions>;
      // Modules made by createCodemodeModule(), by specifier.
      codemodeModules?: ReadonlyMap<string, CodemodeModuleRuntime>;
      // This scope's value of a scoped context, started the first time
      // it's asked for.
      scopedContext?: (specifier: string, name: string, signal: AbortSignal) => Promise<unknown>;
      // Called for each live object with a disposer, so the scope can
      // dispose it when it ends, and again when it's released early.
      trackDisposable?: (
        key: string,
        close: (end: WorkspaceModuleScopeEnd) => Promise<void>,
      ) => void;
      untrackDisposable?: (key: string) => void;
      maxPayloadBytes?: number;
      maxCallDurationMs?: number;
      maxConcurrentCalls?: number;
      maxCalls?: number;
      maxTotalRequestBytes?: number;
      maxTotalResponseBytes?: number;
      maxResultBytes?: number;
      onAttachOutput?: (readable: ReadableStream<Uint8Array>) => Promise<void>;
      journal?: BridgeJournal;
      // Makes network requests for the isolate's journaled fetch. Absent
      // when the isolate has no network access.
      fetch?: (request: Request) => Promise<Response>;
      // The execution every call belongs to. Its id prefixes each call's
      // callId. A bridge without one, as in a test, gets a random id.
      execution?: WorkspaceModuleExecution;
      // Called when a call interrupts, to release the run.
      onWait?: (call: { seq: number; payload: unknown; since: number }) => void;
    } = {},
  ) {
    super();
    this.#capability = capability;
    this.#hostModules = integrations.hostModules ?? new Map();
    this.#codemode = integrations.codemodeModules ?? new Map();
    this.#scopedContext = integrations.scopedContext;
    this.#trackDisposable = integrations.trackDisposable;
    this.#untrackDisposable = integrations.untrackDisposable;
    this.#maxPayloadBytes = integrations.maxPayloadBytes ?? 1024 * 1024;
    this.#maxCallDurationMs = integrations.maxCallDurationMs ?? 30_000;
    this.#maxConcurrentCalls = integrations.maxConcurrentCalls ?? 16;
    this.#maxCalls = integrations.maxCalls ?? 256;
    this.#maxTotalRequestBytes = integrations.maxTotalRequestBytes ?? 8 * 1024 * 1024;
    this.#maxTotalResponseBytes = integrations.maxTotalResponseBytes ?? 8 * 1024 * 1024;
    this.#maxResultBytes = integrations.maxResultBytes ?? 1024 * 1024;
    this.#onAttachOutput = integrations.onAttachOutput;
    this.#journal = integrations.journal;
    this.#fetch = integrations.fetch;
    const execution = integrations.execution;
    this.#execution = Object.freeze({
      id: execution?.id ?? crypto.randomUUID(),
      metadata: Object.freeze({ ...execution?.metadata }),
    });
    this.#onWait = integrations.onWait;
  }

  // Drain the runner's framed output stream. The isolate passes the
  // readable end as a call argument (the direction that transfers a
  // live byte stream over the loader boundary) and keeps this call
  // in flight until it closes, which is what holds the bridge stub
  // alive for the whole execution. The host consumer reads frames as
  // they arrive, so output is observable before user code returns.
  async attachOutput(readable: ReadableStream<Uint8Array>): Promise<void> {
    await this.#onAttachOutput?.(readable);
  }

  // Validate an execution result before the runner frames it as JSON.
  // The value crosses as an RPC argument (structured clone, full
  // fidelity), so a Date or other non-plain value is rejected here
  // rather than silently coerced by the JSON framing downstream.
  async assertResult(value: unknown): Promise<void> {
    assertRuntimeValue(value);
    const bytes = utf8ByteLength(JSON.stringify(value));
    if (bytes > this.#maxResultBytes) {
      throw new Error(`Workspace runtime result exceeds ${this.#maxResultBytes} bytes.`);
    }
  }

  // The one entry point for isolate code. Arguments and results cross
  // as real values through Workers RPC; this method is the proxy that
  // keeps the limits on them, so untrusted code cannot overload the
  // Durable Object with calls, concurrency, time, or bytes.
  call(name: string, args: unknown[], log?: BridgeLogChunk): Promise<BridgeResponse> {
    const reject = (message: string) =>
      Promise.resolve(boundedError(new Error(message), this.#maxPayloadBytes));
    if (this.#cancelled) return reject("Workspace execution is being cancelled.");
    if (typeof name !== "string" || !Array.isArray(args)) {
      return reject("Workspace capability calls take a name and an argument list.");
    }
    // A durable run's events since its last call, saved before the call
    // that may depend on them.
    if (log !== undefined && log !== null && this.#journal !== undefined) {
      try {
        this.#journal.record(log.from, log.events);
      } catch (error) {
        return Promise.resolve(boundedError(error, this.#maxPayloadBytes));
      }
    }
    // The run is being released for an interrupt. A call it makes now
    // runs live when it resumes.
    if (this.#holding) return new Promise<never>(() => undefined);
    let requestBytes: number;
    // A codemode module can take callbacks and other live values, but
    // only in a run that doesn't replay, since the journal can't keep them.
    const codemodeCall = this.#codemodeModuleOf(name) !== undefined;
    const live = codemodeCall
      ? this.#journal === undefined
        ? "allow"
        : "serializable"
      : undefined;
    try {
      requestBytes = measureValue(args, this.#maxPayloadBytes, "request", live);
    } catch (error) {
      return Promise.resolve(boundedError(error, this.#maxPayloadBytes));
    }
    // fetch only comes through here in a replayable run, so it keeps the
    // limits it has anywhere else: none of the capability budgets, and a
    // queue rather than a refusal when too many are open at once.
    const isFetch = name === "net.fetch";
    if (!isFetch) return this.#capabilityCall(name, args, requestBytes, reject);
    return this.#dispatch(name, args, reject, true);
  }

  #capabilityCall(
    name: string,
    args: unknown[],
    requestBytes: number,
    reject: (message: string) => Promise<BridgeResponse>,
  ): Promise<BridgeResponse> {
    if (this.#inFlight.size - this.#fetchesInFlight >= this.#maxConcurrentCalls) {
      return reject(
        `Workspace execution exceeds ${this.#maxConcurrentCalls} concurrent capability calls.`,
      );
    }
    if (this.#calls >= this.#maxCalls) {
      return reject(`Workspace execution exceeds ${this.#maxCalls} capability calls.`);
    }
    if (this.#requestBytes + requestBytes > this.#maxTotalRequestBytes) {
      return reject(
        `Workspace execution capability requests exceed ${this.#maxTotalRequestBytes} bytes.`,
      );
    }
    this.#calls += 1;
    this.#requestBytes += requestBytes;
    return this.#dispatch(name, args, reject, false);
  }

  #dispatch(
    name: string,
    args: unknown[],
    reject: (message: string) => Promise<BridgeResponse>,
    isFetch: boolean,
  ): Promise<BridgeResponse> {
    // A durable execution answers a call it already made from its
    // journal, so the operation doesn't run twice.
    const step = this.#journal?.begin(name, args);
    // Codemode calls carry richer values and errors.
    const codemodeCall = this.#codemodeModuleOf(name) !== undefined;
    if (step?.kind === "replay") {
      // The first attempt counted this response, and the replay repeats
      // that attempt, so it counts again. The budget error wasn't counted.
      if (!isFetch && step.response.uncounted !== true) {
        this.#responseBytes += replayedBytes(step.response, this.#maxPayloadBytes);
      }
      return Promise.resolve(
        this.#forIsolate({ ...step.response, at: step.at, ordinal: step.ordinal }),
      );
    }
    if (step?.kind === "diverge") {
      this.#journal?.diverged(step.message);
      return reject(step.message);
    }
    if (step?.kind === "live" && step.rerun && isUnsafeToRepeat(this.#hostFunction(name))) {
      const message = `The execution was interrupted while ${name.slice("host/".length)} was running, which isn't safe to repeat.`;
      this.#journal?.diverged(message);
      return reject(message);
    }
    // Stable across attempts for a journaled call, unique otherwise.
    const callId = `${this.#execution.id}:${step?.kind === "live" ? step.seq : crypto.randomUUID()}`;
    const abort = new AbortController();
    this.#abortControllers.add(abort);
    const deadline = Date.now() + this.#maxCallDurationMs;
    // The journal holds one answer per call, so a call can wait only once.
    let interrupted = false;
    const operation = respond(
      async () => {
        if (name.startsWith("host/")) {
          const refBase = step?.kind === "live" ? String(step.seq) : `c${++this.#refCounter}`;
          return this.#callHostModule(name, args, step?.kind === "live" && step.rerun, refBase, {
            signal: abort.signal,
            deadline,
            callId,
            execution: this.#execution,
            interrupt: (payload) => {
              if (interrupted) {
                return Promise.reject(
                  new Error("ctx.interrupt() can only be called once per host module call."),
                );
              }
              interrupted = true;
              return this.#interrupt(step, abort, payload);
            },
            access: this.#capability.access,
            resolvePath: (path, options) =>
              this.#capability.resolveConfined(path, options?.allowMissing ?? false),
          });
        }
        if (name === "net.fetch") return this.#fetchFor(args[0], abort.signal);
        const operation = name.startsWith("fs.") ? name.slice(3) : name;
        switch (operation) {
          case "readFile":
            return this.#capability.readFile(String(args[0]));
          case "readFileBytes":
            return this.#capability.readFileBytes(String(args[0]));
          case "stat":
            return this.#capability.stat(String(args[0]));
          case "lstat":
            return this.#capability.lstat(String(args[0]));
          case "exists":
            return this.#capability.exists(String(args[0]));
          case "readlink":
            return this.#capability.readlink(String(args[0]));
          case "readdir":
            return this.#capability.readdir(args[0] === undefined ? "." : String(args[0]));
          case "readdirWithFileTypes":
            return this.#capability.readdirWithFileTypes(
              args[0] === undefined ? "." : String(args[0]),
            );
          case "find":
            return this.#capability.find(
              args[0] === undefined ? "." : String(args[0]),
              args[1] === undefined ? undefined : String(args[1]),
            );
          case "glob":
            return this.#capability.glob(String(args[0]));
          case "ls":
            return this.#capability.ls(args[0] === undefined ? "." : String(args[0]));
          case "grep":
            return this.#capability.grep(
              String(args[0]),
              args[1] === undefined ? "." : String(args[1]),
              args[2] as { ignoreCase?: boolean } | undefined,
            );
          case "writeFile":
            await this.#capability.writeFileNode(
              String(args[0]),
              decodeBytes(args[1]),
              args[2] as { flag?: string } | undefined,
            );
            return null;
          case "mkdir":
            await this.#capability.mkdir(
              String(args[0]),
              args[1] as { recursive?: boolean } | undefined,
            );
            return null;
          case "rm":
            await this.#capability.rm(
              String(args[0]),
              args[1] as { recursive?: boolean; force?: boolean } | undefined,
            );
            return null;
          case "chmod":
            await this.#capability.chmod(String(args[0]), Number(args[1]));
            return null;
          case "symlink":
            await this.#capability.symlink(String(args[0]), String(args[1]));
            return null;
          default:
            throw new Error(`Unknown Workspace code operation ${JSON.stringify(name)}.`);
        }
      },
      this.#maxPayloadBytes,
      this.#journal === undefined && codemodeCall,
      codemodeCall,
    );
    const call = withDeadline(operation, this.#maxCallDurationMs, this.#maxPayloadBytes, () => {
      // A call waiting for an answer isn't late: the run is released.
      if (this.#waiting.has(abort)) return;
      this.#callTimedOut = true;
      abort.abort(new Error("Workspace capability call timed out."));
    });
    // The caller gets a bounded response, but terminal execution waits for
    // the accepted host operation itself. This prevents a late mutation
    // after an exit event when the underlying API cannot be aborted.
    this.#inFlight.add(operation);
    if (isFetch) this.#fetchesInFlight += 1;
    void operation.finally(() => {
      this.#inFlight.delete(operation);
      if (isFetch) this.#fetchesInFlight -= 1;
      this.#abortControllers.delete(abort);
    });
    // Errors count against the response budget too. The budget error
    // itself is short and not counted, and `maxCalls` bounds how many
    // the isolate can see.
    const delivered = call
      .then((response) => {
        if (isFetch) return "result" in response ? { result: response.result } : response;
        const delivered = (): BridgeResponse =>
          "result" in response
            ? {
                result: response.result,
                ...(response.objects === undefined ? {} : { objects: response.objects }),
              }
            : response;
        const bytes = "result" in response ? response.bytes : errorBytes(response);
        if (this.#responseBytes + bytes > this.#maxTotalResponseBytes) {
          return {
            ...boundedError(
              new Error(
                `Workspace execution capability responses exceed ${this.#maxTotalResponseBytes} bytes.`,
              ),
              this.#maxPayloadBytes,
            ),
            uncounted: true as const,
          };
        }
        this.#responseBytes += bytes;
        return delivered();
      })
      .then((response) => {
        // An interrupted call answers nothing: it runs again once answered.
        if (this.#waiting.has(abort)) return new Promise<never>(() => undefined);
        // Write before deliver: the journal holds the response before the
        // isolate can act on it. A filesystem change is synchronous SQL on
        // the same database, with no I/O between it and here, so it and
        // its entry commit in the same implicit transaction.
        if (step?.kind !== "live" || this.#journal === undefined) return this.#forIsolate(response);
        return this.#forIsolate({ ...response, ...this.#journal.commit(step.seq, response) });
      });
    this.#responses.set(delivered, abort);
    void delivered.finally(() => this.#responses.delete(delivered)).catch(() => undefined);
    return delivered;
  }

  #interrupt(
    step: ReturnType<BridgeJournal["begin"]> | undefined,
    abort: AbortController,
    payload: unknown,
  ): Promise<never> {
    if (step?.kind !== "live" || this.#journal === undefined) {
      return Promise.reject(
        new Error(
          'ctx.interrupt() needs a replayable run. Run the execution with onInterrupt: "replay", or make that the backend\'s default.',
        ),
      );
    }
    if (step.answer !== undefined) return Promise.resolve(step.answer.value as never);
    if (this.#cancelled)
      return Promise.reject(new Error("Workspace execution is being cancelled."));
    if (!this.#waiting.has(abort)) {
      let since: number;
      try {
        since = this.#journal.interrupt(step.seq, payload);
      } catch (error) {
        return Promise.reject(error);
      }
      this.#waiting.add(abort);
      this.#waited?.();
      this.#onWait?.({ seq: step.seq, payload, since });
    }
    // Settles only when the run is released and the call aborted.
    return new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
  }

  /**
   * Hold new calls and wait until each one in flight has been answered
   * and journaled, or is waiting itself. The run can then be released
   * without any call running twice when it resumes.
   */
  async quiesce(): Promise<void> {
    this.#holding = true;
    while (true) {
      const answering = [...this.#responses].filter(([, abort]) => !this.#waiting.has(abort));
      if (answering.length === 0) return;
      // Look again once one is answered or starts waiting.
      await new Promise<void>((resolve) => {
        this.#waited = resolve;
        const wake = () => resolve();
        void Promise.race(answering.map(([response]) => response)).then(wake, wake);
      });
    }
  }

  // The isolate is waiting for a journaled call its replay never made.
  reportStall(): void {
    this.#journal?.stalled();
  }

  // Part of a durable run's event log, sent on its own when it grows long
  // between calls and output.
  recordLog(log: BridgeLogChunk): void {
    if (this.#cancelled) return;
    this.#journal?.record(log?.from, log?.events);
  }

  async cancelAndDrain(): Promise<void> {
    this.#cancelled = true;
    this.#scope.abort(new Error("Workspace execution is being cancelled."));
    for (const controller of this.#abortControllers) {
      controller.abort(new Error("Workspace execution is being cancelled."));
    }
    await Promise.allSettled([...this.#inFlight]);
    if (this.#callTimedOut) {
      throw new Error("A Workspace capability call did not settle before its deadline.");
    }
  }

  // `name` is `host/<specifier>.<function>`. Function names are
  // identifiers and never contain a dot, so the last dot splits them
  // from a specifier such as `codemode:a.b`. Own-property checks keep
  // isolate code from reaching `toString` or other inherited members.
  async #callHostModule(
    name: string,
    args: unknown[],
    rerun: boolean,
    refBase: string,
    context: WorkspaceModuleCallContext,
  ) {
    const codemode = this.#codemodeModuleOf(name);
    if (codemode !== undefined) {
      return this.#callCodemode(
        codemode.specifier,
        codemode.runtime,
        name,
        args,
        rerun,
        refBase,
        context,
      );
    }
    const functions = this.#hostModuleOf(name);
    const fn = this.#hostFunction(name, functions);
    if (fn === undefined) {
      throw new Error(`Unknown Workspace host module call ${JSON.stringify(name)}.`);
    }
    // Called on its module, so a method that uses `this` still works.
    const result = await fn.call(functions, hostArguments(args), context);
    return hostValue(result ?? null);
  }

  /**
   * Let go of an object code released early, with `using` or
   * `Symbol.dispose`. Its disposer runs with reason "disposed", and the
   * ref can't be called again in this scope.
   */
  async release(ref: unknown): Promise<void> {
    if (typeof ref !== "string") return;
    this.#known.delete(ref);
    const object = this.#live.get(ref);
    this.#live.delete(ref);
    if (object === undefined || disposerOf(object) === undefined) return;
    this.#untrackDisposable?.(`object:${ref}`);
    const deadline = Date.now() + this.#maxCallDurationMs;
    const signal = AbortSignal.timeout(this.#maxCallDurationMs);
    try {
      await disposeObject(object, Object.freeze({ reason: "disposed", signal, deadline }));
    } catch (error) {
      console.error({ message: "Codemode object dispose failed", ref, error: String(error) });
    }
  }

  // The codemode module a call name belongs to, from
  // `host/<specifier>.<function>` or `host/<specifier>#<id>.<method>`.
  #codemodeModuleOf(name: string) {
    const target = moduleSpecifier(name);
    if (target === undefined) return undefined;
    const hash = target.indexOf("#");
    const specifier = hash === -1 ? target : target.slice(0, hash);
    const runtime = this.#codemode.get(specifier);
    return runtime === undefined ? undefined : { specifier, runtime };
  }

  async #callCodemode(
    specifier: string,
    runtime: CodemodeModuleRuntime,
    name: string,
    args: unknown[],
    rerun: boolean,
    refBase: string,
    context: WorkspaceModuleCallContext,
  ) {
    const target = moduleSpecifier(name) ?? specifier;
    const receiver: Readonly<Record<string, unknown>> =
      target === specifier
        ? runtime.definition.functions
        : (this.#object(runtime, target) as Readonly<Record<string, unknown>>);
    const methodName = name.slice(name.lastIndexOf(".") + 1);
    const fn = Object.hasOwn(receiver, methodName) ? receiver[methodName] : undefined;
    if (typeof fn !== "function") {
      throw new Error(`Unknown Workspace host module call ${JSON.stringify(name)}.`);
    }
    if (rerun && isUnsafeToRepeat(fn)) {
      const message = `The execution was interrupted while ${name.slice("host/".length)} was running, which isn't safe to repeat.`;
      this.#journal?.diverged(message);
      throw new Error(message);
    }
    const value: unknown = await fn.call(
      receiver,
      args,
      this.#codemodeContext(specifier, runtime, context),
    );
    return this.#encodeObjects(specifier, runtime, value ?? null, refBase);
  }

  // The live object behind a ref, rebuilt from its state when this scope
  // only replayed it.
  #object(runtime: CodemodeModuleRuntime, ref: string): object {
    const live = this.#live.get(ref);
    if (live !== undefined) return live;
    const known = this.#known.get(ref);
    if (known === undefined) throw new Error(`Unknown codemode object ${JSON.stringify(ref)}.`);
    const build = runtime.definition.kinds.get(known.kind);
    if (build === undefined) {
      throw new Error(
        `Codemode object ${JSON.stringify(ref)} is a ${JSON.stringify(known.kind)}, which its module no longer defines.`,
      );
    }
    const object = build(known.state);
    this.#adopt(ref, object);
    return object;
  }

  #adopt(ref: string, object: object) {
    this.#live.set(ref, object);
    if (disposerOf(object) !== undefined) {
      this.#trackDisposable?.(`object:${ref}`, (end) => disposeObject(object, end));
    }
  }

  // ctx for a codemode call: the call's own context, plus the module's
  // connection context, plus a getter for each scoped context that
  // starts it on first read.
  #codemodeContext(
    specifier: string,
    runtime: CodemodeModuleRuntime,
    context: WorkspaceModuleCallContext,
  ): WorkspaceModuleCallContext {
    const ctx: Record<string, unknown> = { ...context };
    for (const definition of runtime.definition.contexts) {
      if (!definition.scoped) {
        ctx[definition.name] = runtime.connection.get(definition.name);
        continue;
      }
      Object.defineProperty(ctx, definition.name, {
        enumerable: true,
        get: () =>
          this.#scopedContext === undefined
            ? Promise.reject(new Error(`Scoped context ${definition.name} isn't available here.`))
            : this.#scopedContext(specifier, definition.name, this.#scope.signal),
      });
    }
    return Object.freeze(ctx) as unknown as WorkspaceModuleCallContext;
  }

  // Swap each defined object in a result for a marker, and list it with
  // a new ref. The rest follows host module value rules: JSON in a
  // replayable run, anything Workers RPC carries otherwise.
  #encodeObjects(
    specifier: string,
    runtime: CodemodeModuleRuntime,
    value: unknown,
    refBase: string,
  ): CodemodeResult {
    const objects: CodemodeObjectDescriptor[] = [];
    const live = this.#journal === undefined;
    const seen = new Set<object>();
    const visit = (item: unknown): unknown => {
      const info = codemodeObjectInfo(item);
      if (info !== undefined) {
        if (info.owner !== runtime.definition.owner) {
          throw new Error(`${specifier} returned an object from another module.`);
        }
        const ref = `${specifier}#${refBase}:${objects.length}`;
        const state = snapshotState(info.kind, info.state ?? null);
        objects.push({ ref, kind: info.kind, state });
        this.#known.set(ref, { kind: info.kind, state });
        this.#adopt(ref, item as object);
        return { [CODEMODE_OBJECT_MARKER]: objects.length - 1 };
      }
      if (
        item === null ||
        typeof item === "boolean" ||
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item))
      ) {
        return item;
      }
      // Byte arrays cross as they are, in every run.
      if (item instanceof Uint8Array) return item;
      if (typeof item === "object" && item !== null && isPlainContainer(item)) {
        if (seen.has(item)) throw new Error("Host module values must be acyclic.");
        seen.add(item);
        let copy: unknown;
        if (Array.isArray(item)) {
          copy = item.map((child: unknown) => (child === undefined ? null : visit(child)));
        } else {
          const fields: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(item)) {
            if (child !== undefined) {
              Object.defineProperty(fields, key, {
                value: visit(child),
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
          }
          copy = fields;
        }
        seen.delete(item);
        return copy;
      }
      if (live) return item;
      if (typeof item !== "function" && isSerializable(item)) return item;
      throw new Error(REPLAYABLE_RESULT);
    };
    return new CodemodeResult(visit(value), objects);
  }

  // What the isolate sees of a response: objects without their state.
  // A replayed response's objects are remembered, so they can be called.
  #forIsolate(response: BridgeResponse): BridgeResponse {
    if (!("result" in response) || response.objects === undefined) return response;
    for (const object of response.objects) {
      if (!this.#known.has(object.ref) && !this.#live.has(object.ref)) {
        this.#known.set(object.ref, { kind: object.kind, state: object.state });
      }
    }
    return {
      ...response,
      objects: response.objects.map(({ ref, kind }) => ({ ref, kind })),
    };
  }

  #hostModuleOf(name: string) {
    const specifier = moduleSpecifier(name);
    return specifier === undefined ? undefined : this.#hostModules.get(specifier);
  }

  #hostFunction(name: string, functions = this.#hostModuleOf(name)) {
    const functionName = name.slice(name.lastIndexOf(".") + 1);
    const fn =
      functions !== undefined && Object.hasOwn(functions, functionName)
        ? functions[functionName]
        : undefined;
    return typeof fn === "function" ? fn : undefined;
  }

  // A fetch the isolate journals goes through here: the request crosses
  // as plain data, the host makes it through the backend's egress, and
  // the response comes back buffered.
  async #fetchFor(spec: unknown, signal: AbortSignal) {
    if (this.#fetch === undefined) throw new Error("Workspace code has no network access.");
    const fetch = this.#fetch;
    const request = parseFetchRequest(spec, signal);
    // A Worker keeps at most six connections open and queues the rest,
    // which also bounds how many buffered bodies this object holds.
    while (this.#fetchesRunning >= MAX_OPEN_FETCHES) {
      await new Promise<void>((resolve) => this.#fetchQueue.push(resolve));
    }
    this.#fetchesRunning += 1;
    try {
      signal.throwIfAborted();
      const response = await fetch(request);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        url: response.url,
        redirected: response.redirected,
        body: await readLimited(response, this.#maxPayloadBytes),
      };
    } finally {
      this.#fetchesRunning -= 1;
      this.#fetchQueue.shift()?.();
    }
  }
}

const MAX_OPEN_FETCHES = 6;

function parseFetchRequest(spec: unknown, signal: AbortSignal): Request {
  if (spec === null || typeof spec !== "object") throw new Error("fetch takes a request object.");
  const { url, method, headers, body, redirect } = spec as Record<string, unknown>;
  if (typeof url !== "string" || typeof method !== "string") {
    throw new Error("fetch takes a request with a url and a method.");
  }
  if (
    !Array.isArray(headers) ||
    !headers.every((pair) => Array.isArray(pair) && pair.length === 2)
  ) {
    throw new Error("fetch request headers must be name and value pairs.");
  }
  if (body !== null && body !== undefined && !(body instanceof Uint8Array)) {
    throw new Error("fetch request bodies must be bytes.");
  }
  return new Request(url, {
    method,
    headers: headers.map(([name, value]): [string, string] => [String(name), String(value)]),
    body: (body ?? null) as BodyInit | null,
    // The Request constructor rejects a value it doesn't know.
    ...(typeof redirect === "string" ? { redirect: redirect as RequestRedirect } : {}),
    signal,
  });
}

// Read a response body, refusing one larger than the call's payload limit
// before reading all of it.
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`fetch response body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The module specifier in a call name, `host/<specifier>.<function>`.
function moduleSpecifier(name: string): string | undefined {
  if (!name.startsWith("host/")) return undefined;
  const target = name.slice("host/".length);
  const dot = target.lastIndexOf(".");
  return dot === -1 ? undefined : target.slice(0, dot);
}

function hostArguments(args: unknown[]): WorkspaceRuntimeValue[] {
  return args.map((arg) => hostValue(arg ?? null));
}

// Host module values follow JSON: an undefined object field is left
// out, and an undefined array item becomes null, as JSON.stringify
// does. Native RPC would otherwise carry undefined through, and the
// isolate's result check rejects it.
function hostValue(value: unknown): WorkspaceRuntimeValue {
  const seen = new Set<object>();
  const visit = (item: unknown): WorkspaceRuntimeValue => {
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      return item;
    }
    if (typeof item !== "object") throw new Error("Host module values must be JSON-compatible.");
    if (seen.has(item)) throw new Error("Host module values must be acyclic.");
    seen.add(item);
    let copy: WorkspaceRuntimeValue;
    if (Array.isArray(item)) {
      copy = item.map((child: unknown) => (child === undefined ? null : visit(child)));
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Host module values must contain only plain objects.");
      }
      const fields: Record<string, WorkspaceRuntimeValue> = {};
      for (const [key, child] of Object.entries(item)) {
        // defineProperty keeps an own `__proto__` key a field.
        if (child !== undefined) {
          Object.defineProperty(fields, key, {
            value: visit(child),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      copy = fields;
    }
    seen.delete(item);
    return copy;
  };
  return visit(value);
}

function decodeBytes(value: unknown): string | Uint8Array {
  return value instanceof Uint8Array ? value : String(value);
}

function replayedBytes(response: BridgeResponse, maxPayloadBytes: number): number {
  if (!("result" in response)) return errorBytes(response);
  try {
    return measureValue(response.result, maxPayloadBytes, "response");
  } catch {
    // A codemode result with richer values, counted as the journal encodes it.
    try {
      return utf8ByteLength(serialize(response.result));
    } catch {
      return maxPayloadBytes;
    }
  }
}

/** What the bridge sends back for one call: a value, or a bounded error. */
export type BridgeResponse = (
  | {
      readonly result: unknown;
      /** Defined objects in the result, by marker index. */
      readonly objects?: readonly CodemodeObjectDescriptor[];
    }
  | {
      readonly error: {
        readonly message: string;
        readonly code?: string;
        readonly path?: string;
        /** A standard error name, such as "TypeError", for a codemode call. */
        readonly name?: string;
        /** A codemode error's own properties that the journal can keep. */
        readonly props?: Readonly<Record<string, unknown>>;
      };
    }
) & {
  /**
   * When a journaled call's response was delivered. A durable execution's
   * clock reads this, so it reads the same on replay.
   */
  readonly at?: number;
  /** Numbers a journaled response in the order responses were committed. */
  readonly ordinal?: number;
  /** Set on the budget error, which isn't counted against the budget. */
  readonly uncounted?: true;
};

/** Part of a durable run's event log, starting at position `from`. */
export interface BridgeLogChunk {
  readonly from: number;
  readonly events: readonly number[];
}

/** Records a durable execution's calls and answers them on replay. */
export interface BridgeJournal {
  begin(
    name: string,
    args: readonly unknown[],
  ):
    | {
        readonly kind: "replay";
        readonly response: BridgeResponse;
        readonly at: number;
        readonly ordinal: number;
      }
    | {
        readonly kind: "live";
        readonly seq: number;
        readonly rerun: boolean;
        readonly answer?: { readonly value: unknown };
      }
    | { readonly kind: "diverge"; readonly message: string };
  /** Record a live call's response, and return its time and ordinal. */
  commit(seq: number, response: BridgeResponse): { at: number; ordinal: number };
  /** Mark a live call as waiting for an answer, and return when it started. */
  interrupt(seq: number, payload: unknown): number;
  /** Save a chunk of the isolate's event log. Throws on a malformed one. */
  record(position: unknown, events: unknown): void;
  /** Called when a call doesn't match the journal. */
  diverged(message: string): void;
  /** Called when the isolate waits for a journaled call it never makes. */
  stalled(): void;
}

// A response before the per-execution budget check, carrying its size.
type MeasuredResponse =
  | { result: unknown; objects?: readonly CodemodeObjectDescriptor[]; bytes: number }
  | Extract<BridgeResponse, { error: unknown }>;

// Measure plain data the way it costs the Durable Object: UTF-8 bytes
// of strings and keys, raw bytes of byte arrays, and a small fixed cost
// per scalar. Anything that is not plain data is rejected, including
// functions and RPC stubs, which Workers RPC would otherwise carry into
// the host as live callbacks, and cycles.
function measureValue(
  value: unknown,
  maxBytes: number,
  kind: "request" | "response",
  // "allow" counts a live value, such as a callback or stream, as a small
  // fixed cost. "serializable" accepts a richer value the journal can
  // keep, counted by its encoding. Any other string is the error to
  // refuse one with.
  live?: "allow" | "serializable" | string,
): number {
  let bytes = 0;
  const seen = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) {
      throw new Error(`Workspace capability ${kind} exceeds ${maxBytes} bytes.`);
    }
  };
  const visit = (item: unknown): void => {
    if (
      item === null ||
      item === undefined ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      add(8);
      return;
    }
    // Every value costs at least one byte, so the byte limit also bounds
    // how many values the host walks, even for empty strings and objects.
    if (typeof item === "string") {
      add(Math.max(1, utf8ByteLength(item)));
      return;
    }
    if (item instanceof Uint8Array) {
      add(Math.max(1, item.byteLength));
      return;
    }
    if (typeof item !== "object" || !isPlainContainer(item)) {
      if (live === "allow") {
        add(8);
        return;
      }
      if (live === "serializable") {
        // A replayable run can take anything the journal can keep.
        if (typeof item === "function" || !isSerializable(item)) {
          throw new Error(REPLAYABLE_LIVE_VALUE);
        }
        add(Math.max(1, utf8ByteLength(serialize(item))));
        return;
      }
      if (live !== undefined) throw new Error(live);
    }
    if (typeof item !== "object") {
      throw new Error(`Workspace capability ${kind} values must be plain data.`);
    }
    if (seen.has(item)) throw new Error(`Workspace capability ${kind} values must be acyclic.`);
    seen.add(item);
    if (Array.isArray(item)) {
      add(8);
      for (const child of item) visit(child);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Workspace capability ${kind} values must be plain data.`);
      }
      add(8);
      for (const [key, child] of Object.entries(item)) {
        add(Math.max(1, utf8ByteLength(key)));
        visit(child);
      }
    }
    seen.delete(item);
  };
  visit(value);
  return bytes;
}

function withDeadline(
  call: Promise<MeasuredResponse>,
  timeoutMs: number,
  maxPayloadBytes: number,
  onTimeout: () => void,
): Promise<MeasuredResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MeasuredResponse>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(boundedError(new Error("Workspace capability call timed out."), maxPayloadBytes));
    }, timeoutMs);
  });
  return Promise.race([call, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function respond(
  run: () => Promise<unknown>,
  maxPayloadBytes: number,
  allowLive = false,
  richErrors = false,
): Promise<MeasuredResponse> {
  try {
    const result = await run();
    const live = allowLive ? "allow" : undefined;
    if (result instanceof CodemodeResult) {
      // A replayable run's values are counted as the journal encodes them.
      const bytes =
        (allowLive
          ? measureValue(result.value, maxPayloadBytes, "response", live)
          : utf8ByteLength(serialize(result.value))) +
        (result.objects.length === 0 ? 0 : utf8ByteLength(serialize(result.objects)));
      if (bytes > maxPayloadBytes) {
        throw new Error(`Workspace capability response exceeds ${maxPayloadBytes} bytes.`);
      }
      return result.objects.length === 0
        ? { result: result.value, bytes }
        : { result: result.value, objects: result.objects, bytes };
    }
    return { result, bytes: measureValue(result, maxPayloadBytes, "response", live) };
  } catch (error) {
    return boundedError(error, maxPayloadBytes, richErrors);
  }
}

// Room for the envelope's keys and punctuation around the strings.
const ERROR_OVERHEAD_BYTES = 64;

// An error the isolate can rebuild, cut to fit the payload limit as a
// whole. `code` and `path` carry node:fs error details. Each is kept if
// it fits beside the message, or beside half the room when the message
// is long, and the message is cut to what is left.
function boundedError(error: unknown, maxPayloadBytes: number, rich = false) {
  const value = error as { code?: unknown; path?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  let room = Math.max(0, maxPayloadBytes - ERROR_OVERHEAD_BYTES);
  const messageReserve = Math.min(utf8ByteLength(message), room / 2);
  const details: {
    code?: string;
    path?: string;
    name?: string;
    props?: Record<string, unknown>;
  } = {};
  // A codemode error keeps a standard error name and the own properties
  // the journal can keep, if they fit beside the message.
  if (rich && error instanceof Error) {
    if (ERROR_NAMES.has(error.name)) {
      details.name = error.name;
      room -= utf8ByteLength(error.name);
    }
    const props: Record<string, unknown> = {};
    for (const key of Object.keys(error)) {
      if (key === "message" || key === "stack") continue;
      const prop = (error as unknown as Record<string, unknown>)[key];
      if (typeof prop !== "function" && isSerializable(prop)) props[key] = prop;
    }
    if (Object.keys(props).length > 0) {
      const bytes = utf8ByteLength(serialize(props));
      if (bytes <= room - messageReserve) {
        details.props = props;
        room -= bytes;
      }
    }
  }
  for (const key of ["code", "path"] as const) {
    const detail = value?.[key];
    if (typeof detail !== "string") continue;
    const bytes = utf8ByteLength(detail);
    if (bytes > room - messageReserve) continue;
    details[key] = detail;
    room -= bytes;
  }
  return { error: { message: truncateText(message, room), ...details } };
}

function errorBytes(response: Extract<BridgeResponse, { error: unknown }>): number {
  const { message, code, path, name, props } = response.error;
  return (
    ERROR_OVERHEAD_BYTES +
    utf8ByteLength(message) +
    utf8ByteLength(code ?? "") +
    utf8ByteLength(path ?? "") +
    utf8ByteLength(name ?? "") +
    (props === undefined ? 0 : utf8ByteLength(serialize(props)))
  );
}

// Error names the isolate can rebuild with the same constructor.
const ERROR_NAMES = new Set([
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

function truncateText(value: string, maxBytes: number) {
  return utf8Prefix(value, maxBytes).text;
}

// An array, or an object whose prototype is Object.prototype or null.
function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  if (value instanceof Uint8Array) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type Disposer = (end: WorkspaceModuleScopeEnd) => unknown;

function disposerOf(object: object): Disposer | undefined {
  const value = object as { [Symbol.asyncDispose]?: unknown; [Symbol.dispose]?: unknown };
  const dispose = value[Symbol.asyncDispose] ?? value[Symbol.dispose];
  return typeof dispose === "function" ? (dispose as Disposer) : undefined;
}

async function disposeObject(object: object, end: WorkspaceModuleScopeEnd): Promise<void> {
  await disposerOf(object)?.call(object, end);
}

// Whether a replayable run can carry a value: Cap'n Web can encode it
// for the journal, and Workers RPC can send it to the isolate. Of what
// Cap'n Web encodes, only URL is refused by Workers RPC.
function isSerializable(value: unknown): boolean {
  if (containsUrl(value, new Set())) return false;
  try {
    serialize(value);
    return true;
  } catch {
    return false;
  }
}

function containsUrl(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof URL) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => containsUrl(child, seen));
}

// A copy of an object's state, as the journal will keep it.
function snapshotState(kind: string, state: unknown): unknown {
  try {
    if (containsUrl(state, new Set())) throw new Error("Workers RPC can't carry a URL.");
    return deserialize(serialize(state));
  } catch (error) {
    throw new Error(
      `Codemode object ${JSON.stringify(kind)}'s state must be serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
