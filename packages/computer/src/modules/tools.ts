import type {
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

export interface ModuleTool {
  readonly name: string;
  execute(
    args: Record<string, WorkspaceRuntimeValue>,
    context: { signal: AbortSignal },
  ): Promise<WorkspaceRuntimeValue> | WorkspaceRuntimeValue;
}

export interface ToolsModuleOptions {
  readonly exclude?: readonly string[];
}

const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(["default", "then"]);

export function createToolsModule(
  tools: () => readonly ModuleTool[],
  options: ToolsModuleOptions = {},
): WorkspaceModuleFactory {
  const excluded = new Set(options.exclude ?? []);
  const available = () =>
    tools().filter(
      (tool) => !excluded.has(tool.name) && EXPORT_NAME.test(tool.name) && !RESERVED.has(tool.name),
    );
  const create = (): WorkspaceModuleFunctions => {
    const functions: Record<string, WorkspaceModuleFunction> = {};
    for (const tool of available()) {
      functions[tool.name] = async (args, context) => {
        if (args.length > 1) {
          throw new TypeError(`${tool.name}(arguments) takes one object of the tool's arguments.`);
        }
        const [input] = args;
        if (
          input !== undefined &&
          input !== null &&
          (typeof input !== "object" || Array.isArray(input))
        ) {
          throw new TypeError(`${tool.name}: arguments must be an object.`);
        }
        context.signal.throwIfAborted();
        return tool.execute(input ?? {}, { signal: context.signal });
      };
    }
    return functions;
  };
  return Object.defineProperty(create, "description", {
    enumerable: true,
    get() {
      const names = available().map((tool) => `\`${tool.name}\``);
      const listed =
        names.length === 0 ? "No tools are available." : `Exports ${names.join(", ")}.`;
      const left = [...excluded].map((name) => `\`${name}\``);
      return [
        "The agent's own tools, callable from code under the same names.",
        listed,
        "Each takes one object of the tool's arguments.",
        ...(left.length === 0 ? [] : [`There is no ${left.join(" or ")} export.`]),
      ].join(" ");
    },
  }) as WorkspaceModuleFactory;
}
