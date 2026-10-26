// `ws:tools`: an agent's own tools for isolate JavaScript.
//
//   import { read, grep } from "ws:tools";
//   const { text, details, isError } = await read({ path: "README.md" });
//
// Each tool becomes an export under its own name, taking the one object
// of arguments the model would pass. What a tool is and how it runs
// belongs to the agent library, so this module takes bindings: a name
// and a function to call. `forPiTools` in `@cloudflare/computer/tools/pi-ai`
// builds them from pi tools.
//
// `exec` is left out by default. The code calling these tools is
// already running inside `exec`, and a run that can start runs has no
// bound on how deep it goes.
//
// A read-only backend gets only the tools marked `readOnly`, the same
// way `ws:git` and `ws:container` refuse to write there. This module
// cannot tell what a tool does, so a tool that is not marked is taken
// to write.

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types";

/** One tool, as code calls it. */
export interface ToolBinding {
  readonly name: string;
  /**
   * The tool only reads. On a read-only backend, calls to any tool
   * without it are refused before the tool runs.
   */
  readonly readOnly?: boolean;
  /**
   * Run the tool. `input` is the single object the code passed, or `{}`
   * when it passed nothing. Check it as strictly as a model's call.
   */
  call(
    input: Record<string, WorkspaceRuntimeValue>,
    context: WorkspaceModuleCallContext,
  ): Promise<ToolBindingResult> | ToolBindingResult;
}

/** What a tool call returns to code. */
export interface ToolBindingResult {
  /** The tool's text output, as the model would read it. */
  readonly text: string;
  /** Whether the tool reported a failure. A tool that throws rejects the call instead. */
  readonly isError: boolean;
  /** The tool's structured result, for code to read. `null` when it has none. */
  readonly details?: WorkspaceRuntimeValue;
  /** Present when the tool also returns machine-readable output. */
  readonly structuredContent?: WorkspaceRuntimeValue;
}

/** The tools to export, or a function returning them, called each time a backend connects. */
export type ToolBindings = Iterable<ToolBinding> | (() => Iterable<ToolBinding>);

/** Options for {@link createToolBindings}. */
export interface ToolBindingsOptions {
  /** Tools never exported. Defaults to `["exec"]`; pass `[]` to export every tool. */
  readonly exclude?: readonly string[];
  /** Replaces the module's description for a model. */
  readonly description?: string;
}

// Names an identifier can spell but an export cannot use. The backend
// refuses `default` and `then`, and assigning `__proto__` to the
// exports object would replace its prototype instead of adding one.
const RESERVED_EXPORT_NAMES = new Set(["default", "then", "__proto__"]);

/**
 * Build the `ws:tools` host module.
 *
 * Pass a function rather than a list when the tools depend on something
 * that does not exist yet when the backend is constructed, such as the
 * Workspace they act on. The function runs once per connection, so
 * tools added later reach the next connection, not this one.
 *
 * @param bindings - The tools, or a function returning them.
 * @param options - Tools to leave out, and a replacement description.
 * @returns The module to pass as `modules["ws:tools"]`.
 * @throws When the backend connects, if two tools share an export name
 *   once their names are made into identifiers.
 */
export function createToolBindings(
  bindings: ToolBindings,
  options: ToolBindingsOptions = {},
): WorkspaceModuleFactory {
  const exclude = new Set(options.exclude ?? ["exec"]);
  const create = (_host: WorkspaceModuleHost): WorkspaceModuleFunctions => {
    const functions: Record<string, WorkspaceModuleFunction> = {};
    for (const binding of typeof bindings === "function" ? bindings() : bindings) {
      if (exclude.has(binding.name)) continue;
      const name = exportName(binding.name);
      if (Object.hasOwn(functions, name)) {
        throw new Error(`Two tools are exported as ${JSON.stringify(name)}.`);
      }
      functions[name] = async (args, context) => {
        if (binding.readOnly !== true && context.access !== "read-write") {
          throw new Error(`ws:tools ${binding.name} requires Workspace write access.`);
        }
        // A tool may ignore the signal, so a call cancelled while it
        // waited must not start it.
        context.signal.throwIfAborted();
        return binding.call(singleObject(binding.name, args), context);
      };
    }
    return functions;
  };
  return Object.defineProperty(create, "description", {
    enumerable: true,
    get: () => options.description ?? describe(exportNames(bindings, exclude), [...exclude]),
  }) as WorkspaceModuleFactory;
}

// The names code can import, for the description. A function of tools
// is called again, so the list is current whenever the backend
// describes itself. Any other iterable may be single-use, so it is
// left for the connection to read, and a function that throws leaves
// the list out rather than the whole description.
function exportNames(bindings: ToolBindings, exclude: ReadonlySet<string>): string[] | undefined {
  if (typeof bindings !== "function" && !Array.isArray(bindings)) return undefined;
  try {
    const list = typeof bindings === "function" ? bindings() : bindings;
    return [...list]
      .filter((binding) => !exclude.has(binding.name))
      .map((binding) => exportName(binding.name));
  } catch {
    return undefined;
  }
}

/**
 * Turn a tool name into an export name: separators become `_`, other
 * characters that cannot appear in an identifier are dropped, a leading
 * digit gets a `_` in front, and `default`, `then`, and `__proto__` get
 * one behind.
 * `list-files` becomes `list_files`.
 */
function exportName(toolName: string): string {
  let name = toolName.replace(/[-.\s]/g, "_").replace(/[^A-Za-z0-9_$]/g, "");
  if (name === "") return "_";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (RESERVED_EXPORT_NAMES.has(name)) name = `${name}_`;
  return name;
}

function singleObject(
  name: string,
  args: readonly WorkspaceRuntimeValue[],
): Record<string, WorkspaceRuntimeValue> {
  const [input = {}, ...rest] = args;
  if (rest.length > 0 || input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name}(arguments) takes one object of the tool's arguments.`);
  }
  return input;
}

function describe(exported: readonly string[] | undefined, excluded: readonly string[]): string {
  const intro =
    "The agent's own tools, callable from code. Each is exported under its name made into an identifier: `-`, `.`, and spaces become `_`, and other characters an identifier cannot hold are dropped, so `list-files` becomes `list_files`. Each takes one object of the tool's arguments and returns `{ text, details, isError }`.";
  const base =
    exported === undefined || exported.length === 0
      ? intro
      : `${intro} It exports ${exported.map((name) => `\`${name}\``).join(", ")}.`;
  if (excluded.length === 0) return base;
  const names = excluded.map((name) => `\`${name}\``);
  return excluded.length === 1
    ? `${base} There is no ${names[0]} export: importing it fails.`
    : `${base} There are no ${names.join(" or ")} exports: importing them fails.`;
}
