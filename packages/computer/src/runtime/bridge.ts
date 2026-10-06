import { RpcTarget } from "cloudflare:workers";

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
  readonly #inFlight = new Set<Promise<string>>();
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

  call(name: string, argsJson: string): Promise<string> {
    const requestBytes = new TextEncoder().encode(argsJson).byteLength;
    const reject = (message: string) =>
      Promise.resolve(encodeBoundedError(new Error(message), this.#maxPayloadBytes));
    if (this.#cancelled) return reject("Workspace execution is being cancelled.");
    if (requestBytes > this.#maxPayloadBytes) {
      return reject(`Workspace capability request exceeds ${this.#maxPayloadBytes} bytes.`);
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
    const operation = encodeCall(async () => {
      const encodedArgs = JSON.parse(argsJson) as unknown[];
      const args = encodedArgs.map(decodeBridgeValue);
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
      const bytes = new TextEncoder().encode(response).byteLength;
      if (this.#responseBytes + bytes > this.#maxTotalResponseBytes) {
        return encodeBoundedError(
          new Error(
            `Workspace execution capability responses exceed ${this.#maxTotalResponseBytes} bytes.`,
          ),
          this.#maxPayloadBytes,
        );
      }
      this.#responseBytes += bytes;
      return response;
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
    // Called on its module, so a method that uses `this` still works.
    const result = (await fn.call(functions, args, context)) ?? null;
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
      // An undefined field is absent, as in JSON. encodeBridgeValue drops it.
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

function encodeBridgeValue(value: unknown): unknown {
  const wrap = (type: string, fields: Record<string, unknown>) => ({
    __workspace_codec__: { version: 1, type, ...fields },
  });
  if (value instanceof Uint8Array) return wrap("bytes", { data: Array.from(value) });
  if (Array.isArray(value)) return wrap("array", { items: value.map(encodeBridgeValue) });
  if (value && typeof value === "object") {
    return wrap("object", {
      entries: Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, encodeBridgeValue(child)]),
    });
  }
  return value;
}

function decodeBridgeValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("__workspace_codec__" in record)) {
    throw new Error("Invalid Workspace codec envelope.");
  }
  const codec = record.__workspace_codec__ as Record<string, unknown> | null;
  if (codec?.version !== 1) throw new Error("Invalid Workspace codec envelope.");
  if (codec.type === "bytes") {
    if (!isByteArray(codec.data)) throw new Error("Invalid Workspace byte value.");
    return new Uint8Array(codec.data);
  }
  if (codec.type === "array" && Array.isArray(codec.items)) {
    return codec.items.map(decodeBridgeValue);
  }
  if (codec.type === "object" && Array.isArray(codec.entries)) {
    return Object.fromEntries(
      codec.entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          throw new Error("Invalid Workspace object entry.");
        }
        return [entry[0], decodeBridgeValue(entry[1])];
      }),
    );
  }
  throw new Error("Invalid Workspace codec envelope.");
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function withDeadline(
  call: Promise<string>,
  timeoutMs: number,
  maxPayloadBytes: number,
  onTimeout: () => void,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(
        encodeBoundedError(new Error("Workspace capability call timed out."), maxPayloadBytes),
      );
    }, timeoutMs);
  });
  return Promise.race([call, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function encodeCall(run: () => Promise<unknown>, maxPayloadBytes: number) {
  try {
    const result = await run();
    assertResponseWithin(result, maxPayloadBytes);
    const encoded = JSON.stringify({ result: encodeBridgeValue(result) });
    if (new TextEncoder().encode(encoded).byteLength > maxPayloadBytes) {
      throw new Error(`Workspace capability response exceeds ${maxPayloadBytes} bytes.`);
    }
    return encoded;
  } catch (error) {
    return encodeBoundedError(error, maxPayloadBytes);
  }
}

function assertResponseWithin(value: unknown, maxBytes: number) {
  let bytes = 0;
  let nodes = 0;
  const visit = (item: unknown): void => {
    nodes += 1;
    if (nodes > 4096) throw new Error("Workspace capability response has too many values.");
    if (typeof item === "string") bytes += item.length * 3;
    else if (item instanceof Uint8Array) bytes += item.byteLength * 4;
    else if (typeof item === "number" || typeof item === "boolean" || item === null) bytes += 16;
    else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        bytes += key.length * 3;
        visit(child);
      }
    }
    if (bytes > maxBytes) {
      throw new Error(`Workspace capability response exceeds ${maxBytes} bytes.`);
    }
  };
  visit(value);
}

function encodeBoundedError(error: unknown, maxPayloadBytes: number) {
  const value = error as { code?: unknown; path?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  const detailed = JSON.stringify({
    error: {
      message,
      ...(typeof value?.code === "string" ? { code: value.code } : {}),
      ...(typeof value?.path === "string" ? { path: value.path } : {}),
    },
  });
  const encoder = new TextEncoder();
  if (encoder.encode(detailed).byteLength <= maxPayloadBytes) return detailed;

  let budget = Math.max(0, maxPayloadBytes - 40);
  while (budget >= 0) {
    const bounded = JSON.stringify({ error: { message: truncateUtf8(message, budget) } });
    if (encoder.encode(bounded).byteLength <= maxPayloadBytes) return bounded;
    budget -= 1;
  }
  return JSON.stringify({ error: { message: "Capability call failed" } });
}

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let prefix = bytes.slice(0, maxBytes);
  while (prefix.byteLength > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    } catch {
      prefix = prefix.slice(0, -1);
    }
  }
  return "";
}
