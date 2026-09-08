// Framework-agnostic `js` tool definition.
//
// A model-facing tool is four things — name, description, input schema,
// execute — and every agent framework (AI SDK, pi, MCP servers,
// OpenAI/LangChain-style registries) wraps that same quartet, because the
// shape is pinned from below by the providers' function-calling APIs. This
// definition carries the quartet with zero framework dependencies: the
// schema is plain JSON Schema (every framework's lingua franca) and the
// output is the session's own `ReplExecutionResult`. Shims adapt it in a
// few lines — see src/tools/js.ts for the AI SDK one; a pi or MCP wrapper
// is the same handful of lines around `run()` and `renderJsResultText()`.

import type { WorkspaceRuntimeLoader } from "../runtime/types.js";
import type { ReplCapability } from "./capability.js";
import type { ReplExecutionResult } from "./types.js";

export interface JsToolInput {
  code: string;
  sessionName?: string;
}

/** The slice of a session the tool drives. `ReplSession` satisfies it. */
export interface JsToolSessionLike {
  eval(code: string): Promise<ReplExecutionResult>;
}

/** The slice of `Workspace` the tool needs. */
export interface JsToolWorkspaceLike {
  repl(
    name: string,
    options: {
      loader: WorkspaceRuntimeLoader;
      capabilities?: Record<string, ReplCapability>;
      timeoutMs?: number;
      maxEffectBytes?: number;
    },
  ): JsToolSessionLike;
}

export interface JsToolOptions {
  workspace: JsToolWorkspaceLike;
  loader: WorkspaceRuntimeLoader;
  /**
   * Capabilities granted to every session this tool touches, by global
   * name. Grants are attach-time: each call re-attaches exactly this set,
   * and the generated tool description lists it.
   */
  capabilities?: Record<string, ReplCapability>;
  /** Session used when the model omits `sessionName`. Default "main". */
  defaultSession?: string;
  timeoutMs?: number;
  maxEffectBytes?: number;
}

export interface JsToolDefinition {
  name: "js";
  /** Generated from the grant set — regenerate by recreating the tool. */
  description: string;
  /**
   * Plain JSON Schema for {@link JsToolInput}. Typed with concrete
   * literals so it satisfies stricter framework types (e.g. the AI SDK's
   * JSONSchema7) without this module depending on any of them.
   */
  inputSchema: {
    type: "object";
    properties: {
      code: { type: "string"; description: string };
      sessionName: { type: "string"; description: string };
    };
    required: ["code"];
    additionalProperties: false;
  };
  /**
   * Evaluate one cell. Structured failures (including the cell's own
   * errors) return as `result.error` — this only throws for caller
   * mistakes like a non-string `code`. `signal` is accepted for shim
   * uniformity; a running cell is bounded by its timeout rather than
   * cancelled mid-flight, so aborting affects only the caller's await.
   */
  run(input: JsToolInput, options?: { signal?: AbortSignal }): Promise<ReplExecutionResult>;
}

export function createJsToolDefinition(options: JsToolOptions): JsToolDefinition {
  const defaultSession = options.defaultSession ?? "main";
  if (typeof defaultSession !== "string" || defaultSession === "") {
    throw new TypeError("createJsToolDefinition: defaultSession must be a non-empty string.");
  }
  const capabilities = options.capabilities ?? {};

  return {
    name: "js",
    description: jsToolDescription(defaultSession, capabilities),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript source for one cell. Top-level await works; the last expression (or an explicit return) is the cell's value.",
        },
        sessionName: {
          type: "string",
          description: `Named session to evaluate in. Omit for "${defaultSession}". Each session is its own persistent state.`,
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async run(input) {
      if (typeof input?.code !== "string") {
        throw new TypeError("js tool: `code` must be a string of JavaScript source.");
      }
      const sessionName = input.sessionName ?? defaultSession;
      if (typeof sessionName !== "string" || sessionName === "") {
        throw new TypeError("js tool: `sessionName` must be a non-empty string.");
      }
      const session = options.workspace.repl(sessionName, {
        loader: options.loader,
        capabilities,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxEffectBytes !== undefined
          ? { maxEffectBytes: options.maxEffectBytes }
          : {}),
      });
      return session.eval(input.code);
    },
  };
}

function jsToolDescription(
  defaultSession: string,
  capabilities: Record<string, ReplCapability>,
): string {
  const intro =
    "Run JavaScript in a persistent session. Variables, functions, and classes " +
    "survive across calls — including restarts — so build state up instead of " +
    "re-sending it. Top-level `await` works; the value of the last expression " +
    "(or an explicit `return`) comes back with any console logs. Use " +
    "`emit(value)` to publish extra structured results.";
  const names = Object.keys(capabilities);
  if (names.length === 0) {
    return (
      `${intro} No capabilities are granted — no network or filesystem; ` +
      "pure JavaScript with durable state. `help()` in a cell lists the built-ins."
    );
  }
  const grants = names
    .map((name) => {
      const description = capabilities[name].meta.description;
      return description === undefined ? name : `${name} (${description})`;
    })
    .join(", ");
  return (
    `${intro} Capabilities in session "${defaultSession}": ${grants}. ` +
    'Call `help("name")` in a cell for full docs on any of them.'
  );
}

/**
 * Render an eval result as compact text, in execution-narrative order:
 * logs, emitted results, then the completion value or error. One shared
 * renderer so every framework shim shows the model the same thing.
 */
export function renderJsResultText(result: ReplExecutionResult): string {
  const lines: string[] = [];
  for (const entry of result.logs.entries) {
    lines.push(`[${entry.level}] ${entry.text}`);
  }
  if (result.logs.dropped !== undefined && result.logs.dropped > 0) {
    lines.push(`(${result.logs.dropped} more log entries dropped)`);
  }
  for (const entry of result.results) {
    lines.push(entry.text);
  }
  if (result.error) {
    const kind = result.error.kind === undefined ? "" : ` [${result.error.kind}]`;
    lines.push(`${result.error.name}${kind}: ${result.error.message}`);
    if (result.error.traceback !== undefined) lines.push(result.error.traceback);
  } else if ("value" in result) {
    lines.push(`value: ${stringifyValue(result.value)}`);
  }
  return lines.length === 0 ? "value: undefined" : lines.join("\n");
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "bigint" ? `${v}n` : v,
    );
    if (json !== undefined) return json;
  } catch {
    // Cycles and other non-JSON values fall through to String().
  }
  return String(value);
}
