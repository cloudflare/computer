import { RpcTarget } from "cloudflare:workers";

import type { ArtifactClient } from "../artifacts/index.js";
import type { GitClient } from "../git/index.js";
import { assertRuntimeValue, type WorkspaceRuntimeCapability } from "./capability.js";
import type { WorkspaceTrustedModule } from "./types.js";

export class WorkspaceRuntimeBridge extends RpcTarget {
  readonly #capability: WorkspaceRuntimeCapability;
  readonly #git: GitClient | undefined;
  readonly #artifacts: ArtifactClient | undefined;
  readonly #trustedModules: Record<string, WorkspaceTrustedModule>;
  readonly #allowGitNetwork: boolean;
  readonly #allowArtifactNetwork: boolean;
  readonly #maxPayloadBytes: number;
  readonly #maxCallDurationMs: number;
  readonly #maxConcurrentCalls: number;
  readonly #maxCalls: number;
  readonly #maxTotalRequestBytes: number;
  readonly #maxTotalResponseBytes: number;
  readonly #maxResultBytes: number;
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
      git?: GitClient;
      artifacts?: ArtifactClient;
      trustedModules?: Record<string, WorkspaceTrustedModule>;
      allowGitNetwork?: boolean;
      allowArtifactNetwork?: boolean;
      maxPayloadBytes?: number;
      maxCallDurationMs?: number;
      maxConcurrentCalls?: number;
      maxCalls?: number;
      maxTotalRequestBytes?: number;
      maxTotalResponseBytes?: number;
      maxResultBytes?: number;
    } = {},
  ) {
    super();
    this.#capability = capability;
    this.#git = integrations.git;
    this.#artifacts = integrations.artifacts;
    this.#trustedModules = integrations.trustedModules ?? {};
    this.#allowGitNetwork = integrations.allowGitNetwork ?? false;
    this.#allowArtifactNetwork = integrations.allowArtifactNetwork ?? false;
    this.#maxPayloadBytes = integrations.maxPayloadBytes ?? 1024 * 1024;
    this.#maxCallDurationMs = integrations.maxCallDurationMs ?? 30_000;
    this.#maxConcurrentCalls = integrations.maxConcurrentCalls ?? 16;
    this.#maxCalls = integrations.maxCalls ?? 256;
    this.#maxTotalRequestBytes = integrations.maxTotalRequestBytes ?? 8 * 1024 * 1024;
    this.#maxTotalResponseBytes = integrations.maxTotalResponseBytes ?? 8 * 1024 * 1024;
    this.#maxResultBytes = integrations.maxResultBytes ?? 1024 * 1024;
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
      if (name.startsWith("git.")) return this.#callGit(name.slice(4), args);
      if (name.startsWith("artifacts.")) return this.#callArtifacts(name.slice(10), args);
      if (name.startsWith("trusted/")) {
        return this.#callTrusted(name, args, { signal: abort.signal, deadline });
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

  async #callTrusted(
    name: string,
    args: unknown[],
    context: { signal: AbortSignal; deadline: number },
  ) {
    const suffix = ".call";
    const specifier = name.endsWith(suffix) ? name.slice("trusted/".length, -suffix.length) : "";
    const trusted = this.#trustedModules[specifier];
    if (!trusted) {
      throw new Error(`Unknown trusted Workspace module call ${JSON.stringify(name)}.`);
    }
    const method = String(args[0]);
    const callArgs = args.slice(1);
    assertBridgeValues(callArgs);
    const result = await trusted.call(method, callArgs, context);
    assertBridgeValues([result]);
    return result;
  }

  async #callGit(name: string, args: unknown[]) {
    if (!this.#git) throw new Error("Workspace Git is not configured for this execution.");
    switch (name) {
      case "clone":
        this.#requireWrite("Git clone");
        this.#requireGitNetwork("Git clone");
        return this.#git
          .clone(
            (await this.#gitOptions(args[0], true)) as unknown as Parameters<GitClient["clone"]>[0],
          )
          .then(() => null);
      case "diff":
        return this.#git.diff(
          (await this.#gitOptions(args[0])) as Parameters<GitClient["diff"]>[0],
        );
      case "status":
        return this.#git.status(
          (await this.#gitOptions(args[0])) as Parameters<GitClient["status"]>[0],
        );
      case "log":
        return this.#git.log((await this.#gitOptions(args[0])) as Parameters<GitClient["log"]>[0]);
      case "cli": {
        this.#requireWrite("Git CLI");
        const input = (args[0] ?? {}) as Parameters<GitClient["cli"]>[0];
        assertSafeGitCliArguments(input.argv);
        if (isGitNetworkCommand(input.argv)) this.#requireGitNetwork("Git CLI network command");
        return this.#git.cli({
          ...input,
          cwd: await this.#capability.resolveConfined(input.cwd ?? ".", true),
        });
      }
      default:
        throw new Error(`Unknown Workspace Git operation ${JSON.stringify(name)}.`);
    }
  }

  #callArtifacts(name: string, args: unknown[]) {
    if (!this.#artifacts)
      throw new Error("Workspace Artifacts are not configured for this execution.");
    switch (name) {
      case "create":
        this.#requireWrite("Artifacts create");
        return this.#artifacts.create(
          String(args[0]),
          args[1] as Parameters<ArtifactClient["create"]>[1],
        );
      case "get":
        return this.#artifacts.get(String(args[0]));
      case "list":
        return this.#artifacts.list();
      case "importArtifact":
        this.#requireWrite("Artifacts import");
        if (!this.#allowArtifactNetwork) {
          throw new Error(
            "Artifacts import requires WorkerJavaScriptBackend allowArtifactNetwork: true.",
          );
        }
        return this.#artifacts.import(
          String(args[0]),
          args[1] as Parameters<ArtifactClient["import"]>[1],
          args[2] as Parameters<ArtifactClient["import"]>[2],
        );
      case "deleteArtifact":
        this.#requireWrite("Artifacts delete");
        return this.#artifacts.delete(String(args[0]));
      default:
        throw new Error(`Unknown Workspace Artifacts operation ${JSON.stringify(name)}.`);
    }
  }

  async #gitOptions(value: unknown, allowMissing = false): Promise<Record<string, unknown>> {
    const options = (value ?? {}) as Record<string, unknown>;
    return {
      ...options,
      dir: await this.#capability.resolveConfined(
        typeof options.dir === "string" ? options.dir : ".",
        allowMissing,
      ),
    };
  }

  #requireGitNetwork(operation: string) {
    if (!this.#allowGitNetwork) {
      throw new Error(`${operation} requires WorkerJavaScriptBackend allowGitNetwork: true.`);
    }
  }

  #requireWrite(operation: string) {
    if (this.#capability.access !== "read-write") {
      throw new Error(`${operation} requires Workspace write access.`);
    }
  }
}

function assertSafeGitCliArguments(argv: string[] | undefined) {
  if (
    argv?.some(
      (argument) =>
        argument === "-C" ||
        argument.startsWith("-C") ||
        argument === "--git-dir" ||
        argument.startsWith("--git-dir=") ||
        argument === "--work-tree" ||
        argument.startsWith("--work-tree="),
    )
  ) {
    throw new Error(
      "Git CLI path overrides are not available inside a confined Workspace runtime.",
    );
  }
}

function isGitNetworkCommand(argv: string[] | undefined) {
  const networkCommands = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);
  return argv?.some((argument) => networkCommands.has(argument.toLowerCase())) ?? false;
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
    if (typeof value !== "object")
      throw new Error("Trusted module values must be JSON-compatible.");
    if (seen.has(value)) throw new Error("Trusted module values must be acyclic.");
    seen.add(value);
    if (Array.isArray(value)) for (const item of value) visit(item);
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Trusted module values must contain only plain objects.");
      }
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
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
      entries: Object.entries(value).map(([key, child]) => [key, encodeBridgeValue(child)]),
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
