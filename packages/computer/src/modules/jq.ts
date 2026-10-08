import type {
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";
import { shellQuote } from "../sh.js";

interface JqShell {
  exec(
    command: string,
    options: { stdin?: string; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const OPTION_FLAGS: Readonly<Record<string, string>> = {
  raw: "-r",
  compact: "-c",
  slurp: "-s",
  sort: "-S",
  nullInput: "-n",
};

export function createJqModule(): WorkspaceModuleFactory {
  let shell: Promise<JqShell> | undefined;
  const load = () => {
    shell ??= import("just-bash").then(({ Bash }) => new Bash({ commands: ["jq"] }) as JqShell);
    return shell;
  };
  const create = (): WorkspaceModuleFunctions => ({
    async query(args, context) {
      if (args.length < 2 || args.length > 3) {
        throw new TypeError(
          "query(input, filter, options?) takes an input, a filter, and options.",
        );
      }
      const [input, filter, options] = args;
      if (typeof filter !== "string" || filter.length === 0) {
        throw new TypeError("query: filter must be a non-empty string.");
      }
      const record = optionalObject(options);
      const flags: string[] = [];
      for (const [key, value] of Object.entries(record)) {
        const flag = OPTION_FLAGS[key];
        if (flag === undefined) {
          throw new TypeError(
            `query: unknown option ${JSON.stringify(key)}. Use ${Object.keys(OPTION_FLAGS).join(", ")}.`,
          );
        }
        if (value !== undefined && value !== null && typeof value !== "boolean") {
          throw new TypeError(`query: option ${JSON.stringify(key)} must be a boolean.`);
        }
        if (value === true) flags.push(flag);
      }
      const stdin =
        record.nullInput === true
          ? ""
          : typeof input === "string"
            ? input
            : JSON.stringify(input ?? null);
      context.signal.throwIfAborted();
      const result = await (await load()).exec(["jq", ...flags, shellQuote(filter)].join(" "), {
        stdin,
        signal: context.signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `jq exited with code ${result.exitCode}`);
      }
      return result.stdout;
    },
  });
  return Object.assign(create, {
    description:
      "`query(input, filter, options?)` runs a jq program and returns its output text. `input` is JSON text, or any value, which is encoded as JSON first. Options are `raw`, `compact`, `slurp`, `sort`, and `nullInput`, each a boolean.",
  });
}

function optionalObject(
  value: WorkspaceRuntimeValue | undefined,
): Record<string, WorkspaceRuntimeValue> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("query: options must be an object.");
  }
  return value;
}
