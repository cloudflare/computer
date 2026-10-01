import { RpcTarget } from "cloudflare:workers";

import { utf8Prefix } from "../text-truncation.js";
import { assertRuntimeValue, type WorkspaceRuntimeCapability } from "./capability.js";
import type { WorkspaceModuleCallContext, WorkspaceModuleFunctions } from "./types.js";

export class WorkspaceRuntimeBridge extends RpcTarget {
  readonly #capability: WorkspaceRuntimeCapability;
  readonly #hostModules: ReadonlyMap<string, WorkspaceModuleFunctions>;
  readonly #maxPayloadBytes: number;
  readonly #maxCallDurationMs: number;
  readonly #maxConcurrentCalls: number;
  readonly #maxCalls: number;
  readonly #maxTotalRequestBytes: number;
  readonly #maxTotalResponseBytes: number;
  readonly #maxResultBytes: number;
  readonly #onAttachOutput?: (readable: ReadableStream<Uint8Array>) => Promise<void>;
  readonly #inFlight = new Set<Promise<MeasuredResponse>>();
  readonly #abortControllers = new Set<AbortController>();
  #cancelled = false;
  #callTimedOut = false;
  #calls = 0;
  #requestBytes = 0;
  #responseBytes = 0;

  constructor(
    capability: WorkspaceRuntimeCapability,
    integrations: {
      hostModules?: ReadonlyMap<string, WorkspaceModuleFunctions>;
      maxPayloadBytes?: number;
      maxCallDurationMs?: number;
      maxConcurrentCalls?: number;
      maxCalls?: number;
      maxTotalRequestBytes?: number;
      maxTotalResponseBytes?: number;
      maxResultBytes?: number;
      onAttachOutput?: (readable: ReadableStream<Uint8Array>) => Promise<void>;
    } = {},
  ) {
    super();
    this.#capability = capability;
    this.#hostModules = integrations.hostModules ?? new Map();
    this.#maxPayloadBytes = integrations.maxPayloadBytes ?? 1024 * 1024;
    this.#maxCallDurationMs = integrations.maxCallDurationMs ?? 30_000;
    this.#maxConcurrentCalls = integrations.maxConcurrentCalls ?? 16;
    this.#maxCalls = integrations.maxCalls ?? 256;
    this.#maxTotalRequestBytes = integrations.maxTotalRequestBytes ?? 8 * 1024 * 1024;
    this.#maxTotalResponseBytes = integrations.maxTotalResponseBytes ?? 8 * 1024 * 1024;
    this.#maxResultBytes = integrations.maxResultBytes ?? 1024 * 1024;
    this.#onAttachOutput = integrations.onAttachOutput;
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
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > this.#maxResultBytes) {
      throw new Error(`Workspace runtime result exceeds ${this.#maxResultBytes} bytes.`);
    }
  }

  // The one entry point for isolate code. Arguments and results cross
  // as real values through Workers RPC; this method is the proxy that
  // keeps the limits on them, so untrusted code cannot overload the
  // Durable Object with calls, concurrency, time, or bytes.
  call(name: string, args: unknown[]): Promise<BridgeResponse> {
    const reject = (message: string) =>
      Promise.resolve(boundedError(new Error(message), this.#maxPayloadBytes));
    if (this.#cancelled) return reject("Workspace execution is being cancelled.");
    if (typeof name !== "string" || !Array.isArray(args)) {
      return reject("Workspace capability calls take a name and an argument list.");
    }
    let requestBytes: number;
    try {
      requestBytes = measureValue(args, this.#maxPayloadBytes, "request");
    } catch (error) {
      return Promise.resolve(boundedError(error, this.#maxPayloadBytes));
    }
    if (this.#inFlight.size >= this.#maxConcurrentCalls) {
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
    const abort = new AbortController();
    this.#abortControllers.add(abort);
    const deadline = Date.now() + this.#maxCallDurationMs;
    const operation = respond(async () => {
      if (name.startsWith("host/")) {
        return this.#callHostModule(name, args, {
          signal: abort.signal,
          deadline,
          access: this.#capability.access,
          resolvePath: (path, options) =>
            this.#capability.resolveConfined(path, options?.allowMissing ?? false),
        });
      }
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
    }, this.#maxPayloadBytes);
    const call = withDeadline(operation, this.#maxCallDurationMs, this.#maxPayloadBytes, () => {
      this.#callTimedOut = true;
      abort.abort(new Error("Workspace capability call timed out."));
    });
    // The caller gets a bounded response, but terminal execution waits for
    // the accepted host operation itself. This prevents a late mutation
    // after an exit event when the underlying API cannot be aborted.
    this.#inFlight.add(operation);
    void operation.finally(() => {
      this.#inFlight.delete(operation);
      this.#abortControllers.delete(abort);
    });
    return call.then((response) => {
      if (!("result" in response)) return response;
      const bytes = response.bytes;
      if (this.#responseBytes + bytes > this.#maxTotalResponseBytes) {
        return boundedError(
          new Error(
            `Workspace execution capability responses exceed ${this.#maxTotalResponseBytes} bytes.`,
          ),
          this.#maxPayloadBytes,
        );
      }
      this.#responseBytes += bytes;
      return { result: response.result };
    });
  }

  async cancelAndDrain(): Promise<void> {
    this.#cancelled = true;
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
  // from a specifier such as `ws:a.b`. Own-property checks keep
  // isolate code from reaching `toString` or other inherited members.
  async #callHostModule(name: string, args: unknown[], context: WorkspaceModuleCallContext) {
    const target = name.slice("host/".length);
    const dot = target.lastIndexOf(".");
    const specifier = dot === -1 ? "" : target.slice(0, dot);
    const functionName = dot === -1 ? "" : target.slice(dot + 1);
    const functions = this.#hostModules.get(specifier);
    const fn =
      functions !== undefined && Object.hasOwn(functions, functionName)
        ? functions[functionName]
        : undefined;
    if (typeof fn !== "function") {
      throw new Error(`Unknown Workspace host module call ${JSON.stringify(name)}.`);
    }
    assertBridgeValues(args);
    const result = (await fn(args, context)) ?? null;
    assertBridgeValues([result]);
    return result;
  }
}

function assertBridgeValues(
  values: unknown[],
): asserts values is import("./types.js").WorkspaceRuntimeValue[] {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value !== "object") throw new Error("Host module values must be JSON-compatible.");
    if (seen.has(value)) throw new Error("Host module values must be acyclic.");
    seen.add(value);
    if (Array.isArray(value)) for (const item of value) visit(item);
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Host module values must contain only plain objects.");
      }
      // An undefined field is allowed, as in JSON, and arrives as undefined.
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (item !== undefined) visit(item);
      }
    }
    seen.delete(value);
  };
  for (const value of values) visit(value);
}

function decodeBytes(value: unknown): string | Uint8Array {
  return value instanceof Uint8Array ? value : String(value);
}

/** What the bridge sends back for one call: a value, or a bounded error. */
export type BridgeResponse =
  | { readonly result: unknown }
  | {
      readonly error: { readonly message: string; readonly code?: string; readonly path?: string };
    };

// A response before the per-execution budget check, carrying its size.
type MeasuredResponse =
  | { result: unknown; bytes: number }
  | Extract<BridgeResponse, { error: unknown }>;

const encoder = new TextEncoder();
const MAX_RESPONSE_VALUES = 4096;

// Measure plain data the way it costs the Durable Object: UTF-8 bytes
// of strings and keys, raw bytes of byte arrays, and a small fixed cost
// per scalar. Anything that is not plain data is rejected, including
// functions and RPC stubs, which Workers RPC would otherwise carry into
// the host as live callbacks, and cycles.
function measureValue(value: unknown, maxBytes: number, kind: "request" | "response"): number {
  let bytes = 0;
  let values = 0;
  const seen = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) {
      throw new Error(`Workspace capability ${kind} exceeds ${maxBytes} bytes.`);
    }
  };
  const visit = (item: unknown): void => {
    values += 1;
    if (kind === "response" && values > MAX_RESPONSE_VALUES) {
      throw new Error("Workspace capability response has too many values.");
    }
    if (
      item === null ||
      item === undefined ||
      typeof item === "boolean" ||
      typeof item === "number"
    ) {
      add(8);
      return;
    }
    if (typeof item === "string") {
      add(encoder.encode(item).byteLength);
      return;
    }
    if (item instanceof Uint8Array) {
      add(item.byteLength);
      return;
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
      for (const [key, child] of Object.entries(item)) {
        add(encoder.encode(key).byteLength);
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
): Promise<MeasuredResponse> {
  try {
    const result = await run();
    return { result, bytes: measureValue(result, maxPayloadBytes, "response") };
  } catch (error) {
    return boundedError(error, maxPayloadBytes);
  }
}

// An error the isolate can rebuild, with its message cut to fit the
// payload limit. `code` and `path` carry node:fs error details.
function boundedError(error: unknown, maxPayloadBytes: number) {
  const value = error as { code?: unknown; path?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      message: truncateText(message, Math.max(0, maxPayloadBytes - 64)),
      ...(typeof value?.code === "string" ? { code: value.code } : {}),
      ...(typeof value?.path === "string" ? { path: value.path } : {}),
    },
  };
}

function truncateText(value: string, maxBytes: number) {
  return utf8Prefix(value, maxBytes).text;
}
