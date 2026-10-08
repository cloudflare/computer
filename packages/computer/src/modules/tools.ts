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

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

/** One tool, as code calls it. */
export interface ToolBinding {
  readonly name: string;
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

// The JavaScript backend's own rule for host module export names.
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_EXPORT_NAMES = new Set(["default", "then"]);

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
 * @throws When the backend connects, if a tool's name cannot be an
 *   export name or two tools share a name.
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
      assertExportName(binding.name);
      if (Object.hasOwn(functions, binding.name)) {
        throw new Error(`Two tools are named ${JSON.stringify(binding.name)}.`);
      }
      functions[binding.name] = async (args, context) =>
        binding.call(singleObject(binding.name, args), context);
    }
    return functions;
  };
  return Object.assign(create, {
    description: options.description ?? describe([...exclude]),
  });
}

function assertExportName(name: string) {
  if (EXPORT_NAME.test(name) && !RESERVED_EXPORT_NAMES.has(name)) return;
  throw new Error(
    `Tool ${JSON.stringify(name)} cannot be exported from ws:tools: export names must be JavaScript identifiers, and not "default" or "then". Leave it out with the exclude option.`,
  );
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

// The description cannot list the tools: the backend reads it when it
// is constructed, before a function of tools has run.
function describe(excluded: readonly string[]): string {
  const base =
    "The agent's own tools, callable from code, under the same names. Each takes one object of the tool's arguments and returns `{ text, details, isError }`.";
  if (excluded.length === 0) return base;
  const names = excluded.map((name) => `\`${name}\``);
  return excluded.length === 1
    ? `${base} There is no ${names[0]} export: importing it fails.`
    : `${base} There are no ${names.join(" or ")} exports: importing them fails.`;
}
