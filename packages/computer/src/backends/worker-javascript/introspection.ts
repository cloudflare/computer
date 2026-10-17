// What code in the isolate can learn about the modules it imports.
//
//   import * as git from "ws:git";
//   import { docs, types } from "cf:computer";
//   docs();          // every module, one line each
//   docs(git);       // one module: its summary, declarations, examples
//   types(git.cli);  // one export's declaration
//
// A host module's code runs in the Durable Object, so the isolate only
// ever holds a stub that forwards the call. The stub has nothing to
// show, so the host sends each module's TypeScript declarations
// instead. The backend renders them here, once per connection, and
// the isolate reads the result as data: `cf:computer` looks entries
// up, a host export prints its declaration, and `console.log` formats
// values the way Node.js does.

import type { WorkspaceModuleTypes } from "../../runtime/types.js";

/** The built-in module code imports to read about the others. */
export const COMPUTER_MODULE = "cf:computer";

/** The internal module holding the catalog, the export registry, and the console formatter. */
export const INTROSPECTION_MODULE = "workspace-introspection.js";

/** One line for the backend's description, beside the other modules. */
export const COMPUTER_DESCRIPTION =
  "- `cf:computer`: how to call every other module. Read a module's docs before you first call it. `docs(module)` returns a module's TypeScript declarations and examples, and `docs()` lists every module. Pass a namespace (`import * as git from \"ws:git\"`), a specifier string, or one export. `types(...)` returns the declarations alone. Printing a host export with `console.log` shows its declaration too.";

/** What the isolate knows about every module it can import. */
export interface ModuleCatalog {
  /** What `docs()` returns: every module, one line each. */
  readonly overview: string;
  /** Each importable module, by specifier. */
  readonly modules: Readonly<Record<string, CatalogModule>>;
}

/** One module in the catalog. */
export interface CatalogModule {
  /** What `docs(module)` returns. */
  readonly docs: string;
  /** What `types(module)` returns. */
  readonly types: string;
  /** A host module's exports, by name. Empty for any other module. */
  readonly exports: Readonly<Record<string, CatalogExport>>;
}

/** One host module export in the catalog. */
export interface CatalogExport {
  /** What `types(fn)` and `docs(fn)` return: the declaration and the types it names. */
  readonly types: string;
  /** What printing the function shows. */
  readonly display: string;
}

/** A module to describe, before rendering. */
export type CatalogEntry =
  | {
      readonly _tag: "host";
      readonly specifier: string;
      readonly summary: string;
      /** The export names the module built on this connection. */
      readonly exports: readonly string[];
      readonly types: WorkspaceModuleTypes | undefined;
      readonly examples: readonly string[] | undefined;
    }
  | {
      readonly _tag: "declared";
      readonly specifier: string;
      readonly summary: string;
      readonly types: WorkspaceModuleTypes;
      readonly examples: readonly string[] | undefined;
    }
  | {
      readonly _tag: "undeclared";
      readonly specifier: string;
      readonly summary: string;
      /** Why there are no declarations, and where to look instead. */
      readonly note: string;
    };

/**
 * Render every module for the isolate.
 *
 * @param overview - What `docs()` returns.
 * @param entries - The modules code can import.
 * @returns The catalog the isolate reads.
 */
export function buildModuleCatalog(
  overview: string,
  entries: readonly CatalogEntry[],
): ModuleCatalog {
  const modules: Record<string, CatalogModule> = Object.create(null);
  for (const entry of entries) modules[entry.specifier] = renderEntry(entry);
  return { overview, modules };
}

function renderEntry(entry: CatalogEntry): CatalogModule {
  switch (entry._tag) {
    case "host": {
      const declared = entry.types ?? {};
      const types = moduleDeclaration(entry.specifier, declared, entry.exports);
      const exports: Record<string, CatalogExport> = Object.create(null);
      for (const name of entry.exports) {
        const declaration = declared[name] ?? fallbackDeclaration(name);
        const related = relatedTypes(declared, entry.exports, declaration);
        exports[name] = {
          types: [...related, declaration].join("\n\n"),
          display: [...related, hostBody(declaration)].join("\n\n"),
        };
      }
      const missing = entry.exports.filter((name) => declared[name] === undefined);
      const note =
        missing.length === 0
          ? undefined
          : `No declarations were given for ${missing.map((name) => `\`${name}\``).join(", ")}, so ${missing.length === 1 ? "it is" : "they are"} shown taking and returning \`unknown\`.`;
      return {
        docs: renderDocs(entry.specifier, entry.summary, types, entry.examples, note),
        types,
        exports,
      };
    }
    case "declared": {
      const names = Object.keys(entry.types);
      const types = moduleDeclaration(entry.specifier, entry.types, names);
      return {
        docs: renderDocs(entry.specifier, entry.summary, types, entry.examples, undefined),
        types,
        exports: Object.create(null),
      };
    }
    case "undeclared": {
      return {
        docs: `# ${entry.specifier}\n\n${sentence(entry.summary)}\n\n${entry.note}`,
        types: `// ${entry.note}`,
        exports: Object.create(null),
      };
    }
  }
}

function renderDocs(
  specifier: string,
  summary: string,
  types: string,
  examples: readonly string[] | undefined,
  note: string | undefined,
): string {
  const fence = "```";
  const sections = [`# ${specifier}`, sentence(summary), `${fence}ts\n${types}\n${fence}`];
  if (note !== undefined) sections.push(note);
  if (examples !== undefined && examples.length > 0) {
    sections.push("Examples:", `${fence}js\n${examples.join("\n")}\n${fence}`);
  }
  return sections.join("\n\n");
}

// Summaries are written to follow a module's name in a list, so most
// start lowercase.
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The declarations that are not exports come first, since the exports
// name them, then every export in the order the module built them.
function moduleDeclaration(
  specifier: string,
  types: WorkspaceModuleTypes,
  exports: readonly string[],
): string {
  const exported = new Set(exports);
  const body = [
    ...Object.keys(types)
      .filter((name) => !exported.has(name))
      .map((name) => types[name] ?? ""),
    ...exports.map((name) => types[name] ?? fallbackDeclaration(name)),
  ];
  return `declare module ${JSON.stringify(specifier)} {\n${indent(body.join("\n\n"))}\n}`;
}

// The non-export declarations a declaration names, and the ones those
// name in turn, in the order the module declared them.
function relatedTypes(
  types: WorkspaceModuleTypes,
  exports: readonly string[],
  declaration: string,
): string[] {
  const exported = new Set(exports);
  const candidates = Object.keys(types).filter((name) => !exported.has(name));
  const found = new Set<string>();
  const pending = [declaration];
  while (pending.length > 0) {
    const text = pending.pop() ?? "";
    for (const name of candidates) {
      if (found.has(name) || !mentions(text, name)) continue;
      found.add(name);
      pending.push(types[name] ?? "");
    }
  }
  return candidates.filter((name) => found.has(name)).map((name) => types[name] ?? "");
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(text);
}

function fallbackDeclaration(name: string): string {
  return `function ${name}(...args: unknown[]): Promise<unknown>;`;
}

// V8 prints a built-in function as `function push() { [native code] }`.
// A host export prints the same way, with the body the isolate can't
// see named for where it runs.
function hostBody(declaration: string): string {
  const trimmed = declaration.trimEnd();
  return trimmed.endsWith(";") ? `${trimmed.slice(0, -1)} { [host code] }` : trimmed;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/** The declarations of the workspace's `node:fs/promises`, which differs from Node's in places. */
export const NODE_FS_PROMISES_TYPES: WorkspaceModuleTypes = {
  Stats: `/** \`mtime\` is milliseconds since the epoch, not a Date. */
interface Stats {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}`,
  Dirent: `interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}`,
  readFile: `/** Without an encoding, the file's bytes. Only "utf8" is supported as an encoding. */
function readFile(path: string): Promise<Uint8Array>;
function readFile(path: string, options: "utf8" | { encoding: "utf8" }): Promise<string>;`,
  writeFile: `/** Creates missing parent directories. \`flag: "wx"\` fails if the file exists. */
function writeFile(path: string, data: string | Uint8Array, options?: { flag?: "w" | "wx" }): Promise<void>;`,
  mkdir: "function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;",
  rm: "function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;",
  readdir: `/** Entry names, or entries with their types when \`withFileTypes\` is set. Defaults to the current directory. */
function readdir(path?: string): Promise<string[]>;
function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;`,
  stat: "function stat(path: string): Promise<Stats>;",
  lstat:
    "/** Like stat, but describes a symlink itself rather than its target. */\nfunction lstat(path: string): Promise<Stats>;",
  readlink: "function readlink(path: string): Promise<string>;",
  symlink: "function symlink(target: string, path: string): Promise<void>;",
  chmod: "function chmod(path: string, mode: number): Promise<void>;",
  access:
    "/** Rejects with code ENOENT when the path does not exist. */\nfunction access(path: string): Promise<void>;",
};

/** The declarations of the workspace's `node:fs`: the promise API, also under `promises`. There are no sync or callback functions. */
export const NODE_FS_TYPES: WorkspaceModuleTypes = {
  ...NODE_FS_PROMISES_TYPES,
  promises:
    '/** The same functions as `node:fs/promises`. */\nconst promises: typeof import("node:fs/promises");',
};

/** The declarations of `cf:computer`. */
export const COMPUTER_TYPES: WorkspaceModuleTypes = {
  ModuleTarget: `/**
 * A module specifier such as "ws:git", a namespace from \`import * as git from "ws:git"\`,
 * or one function a host module exports.
 */
type ModuleTarget = string | object | ((...args: never[]) => unknown);`,
  docs: `/**
 * A module's summary, TypeScript declarations, and examples, as markdown.
 * With no argument, every module code can import, one line each.
 * With one host export, that export's declaration.
 */
function docs(target?: ModuleTarget): string;`,
  types: `/**
 * A module's TypeScript declarations, or one host export's.
 * With no argument, every module's declarations.
 */
function types(target?: ModuleTarget): string;`,
};

/**
 * The internal module the isolate reads the catalog from. Host stubs
 * register through it, `cf:computer` re-exports its lookups, and the
 * runner formats console output with it.
 *
 * @param catalog - Every module code can import, rendered.
 * @returns The module's source.
 */
export function introspectionModuleSource(catalog: ModuleCatalog): string {
  return `
    const catalog = ${JSON.stringify(catalog)};
    const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
    // Every host export, so a function or a namespace leads back to the
    // module it came from. A namespace can't carry a marker of its own.
    const hostExports = new WeakMap();

    export function hostExport(specifier, name, fn) {
      Object.defineProperty(fn, "name", { value: name });
      const entry = catalog.modules[specifier]?.exports[name];
      if (entry !== undefined) {
        Object.defineProperty(fn, "toString", { value: () => entry.display });
        Object.defineProperty(fn, inspectCustom, { value: () => entry.display });
      }
      hostExports.set(fn, { specifier, name });
      return fn;
    }

    function isNamespace(value) {
      return value !== null && typeof value === "object" &&
        Object.prototype.toString.call(value) === "[object Module]";
    }

    function moduleNamed(specifier, caller) {
      const entry = catalog.modules[specifier] ?? catalog.modules["node:" + specifier];
      if (entry === undefined) {
        throw new Error(
          caller + "(" + JSON.stringify(specifier) + "): there is no such module. Modules code can import: " +
          Object.keys(catalog.modules).join(", ") + "."
        );
      }
      return entry;
    }

    function namespaceModule(namespace) {
      for (const key of Object.keys(namespace)) {
        let value;
        try { value = namespace[key]; } catch { continue; }
        const found = typeof value === "function" ? hostExports.get(value) : undefined;
        if (found !== undefined) return found.specifier;
      }
      return undefined;
    }

    function resolve(target, caller) {
      if (typeof target === "string") return { module: moduleNamed(target, caller) };
      if (typeof target === "function") {
        const found = hostExports.get(target);
        if (found === undefined) {
          throw new TypeError(
            caller + "() was passed a function no host module exports. Pass a specifier such as " +
            caller + "(\\"ws:git\\"), a namespace from import * as, or a host export."
          );
        }
        const module = moduleNamed(found.specifier, caller);
        return { module, export: module.exports[found.name] };
      }
      if (isNamespace(target)) {
        const specifier = namespaceModule(target);
        if (specifier === undefined) {
          throw new TypeError(
            caller + "() can only find a host module from its namespace. For any other module, pass its specifier, such as " +
            caller + "(\\"node:fs\\")."
          );
        }
        return { module: moduleNamed(specifier, caller) };
      }
      throw new TypeError(
        caller + "() takes a module specifier, a namespace from import * as, or a host export."
      );
    }

    export function docs(target) {
      if (target === undefined) return catalog.overview;
      const found = resolve(target, "docs");
      return found.export !== undefined ? found.export.types : found.module.docs;
    }

    export function types(target) {
      if (target === undefined) {
        return Object.values(catalog.modules).map((module) => module.types).join("\\n\\n");
      }
      const found = resolve(target, "types");
      return found.export !== undefined ? found.export.types : found.module.types;
    }

    // console.log in Node.js prints strings as they are and inspects
    // everything else. This follows its layout closely enough that a
    // model reads the output as it would Node's.
    export function formatConsole(args) {
      return args.map((value) => typeof value === "string" ? value : inspect(value)).join(" ");
    }

    export function inspect(value) {
      return format(value, 0, new Set());
    }

    const MAX_DEPTH = 3;
    const MAX_ITEMS = 100;
    const LINE_WIDTH = 72;

    function format(value, depth, seen) {
      switch (typeof value) {
        case "string": return depth === 0 ? value : quote(value);
        case "number": return Object.is(value, -0) ? "-0" : String(value);
        case "bigint": return String(value) + "n";
        case "boolean": return String(value);
        case "undefined": return "undefined";
        case "symbol": return value.toString();
        case "function": return formatFunction(value, depth);
      }
      if (value === null) return "null";
      if (seen.has(value)) return "[Circular]";
      if (isNamespace(value)) return formatNamespace(value, depth, seen);
      const custom = customInspect(value, depth);
      if (custom !== undefined) return custom;
      if (value instanceof Error) return formatError(value);
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
      if (value instanceof RegExp) return String(value);
      if (value instanceof Promise) return "Promise { <unknown> }";
      if (value instanceof WeakMap) return "WeakMap { <items unknown> }";
      if (value instanceof WeakSet) return "WeakSet { <items unknown> }";
      if (depth > MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[" + (constructorName(value) ?? "Object") + "]";
      seen.add(value);
      try {
        if (Array.isArray(value)) return group("", "[", "]", listItems(value, depth, seen), depth);
        if (value instanceof Map) {
          const items = [];
          for (const [key, item] of value) {
            if (items.length >= MAX_ITEMS) { items.push("... " + (value.size - MAX_ITEMS) + " more items"); break; }
            items.push(format(key, depth + 1, seen) + " => " + format(item, depth + 1, seen));
          }
          return group("Map(" + value.size + ") ", "{", "}", items, depth);
        }
        if (value instanceof Set) {
          return group("Set(" + value.size + ") ", "{", "}", listItems([...value], depth, seen), depth);
        }
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
          return group(constructorName(value) + "(" + value.length + ") ", "[", "]", listItems(Array.from(value), depth, seen), depth);
        }
        if (value instanceof ArrayBuffer) return "ArrayBuffer { byteLength: " + value.byteLength + " }";
        return formatObject(value, depth, seen);
      } finally {
        seen.delete(value);
      }
    }

    function customInspect(value, depth) {
      let hook;
      try { hook = value[inspectCustom]; } catch { return undefined; }
      if (typeof hook !== "function") return undefined;
      try {
        const result = hook.call(value, MAX_DEPTH - depth, { depth: MAX_DEPTH - depth }, inspect);
        return typeof result === "string" ? result : inspect(result);
      } catch {
        return undefined;
      }
    }

    function formatFunction(fn, depth) {
      const host = hostExports.get(fn);
      if (host !== undefined && depth === 0) {
        const entry = catalog.modules[host.specifier]?.exports[host.name];
        if (entry !== undefined) return entry.display;
      }
      const source = Function.prototype.toString.call(fn);
      const name = fn.name;
      const label = /^class[\\s{]/.test(source)
        ? "[class " + (name || "(anonymous)") + "]"
        : "[Function: " + (name || "(anonymous)") + "]";
      return host === undefined ? label : label + " (" + host.specifier + ")";
    }

    function formatNamespace(namespace, depth, seen) {
      const specifier = namespaceModule(namespace);
      if (specifier !== undefined && depth === 0) {
        return "[Module: " + specifier + "]\\n" + catalog.modules[specifier].types;
      }
      if (specifier !== undefined) return "[Module: " + specifier + "]";
      seen.add(namespace);
      try {
        return formatObject(namespace, depth, seen, "[Module: null prototype] ");
      } finally {
        seen.delete(namespace);
      }
    }

    function formatError(error) {
      const stack = typeof error.stack === "string" && error.stack !== "" ? error.stack : String(error);
      const extras = Object.keys(error).filter((key) => key !== "stack" && key !== "message");
      if (extras.length === 0) return stack;
      const fields = extras.map((key) => key + ": " + format(error[key], 1, new Set([error])));
      return stack + " { " + fields.join(", ") + " }";
    }

    function formatObject(value, depth, seen, prefix) {
      const keys = Object.keys(value);
      const items = [];
      for (const key of keys) {
        if (items.length >= MAX_ITEMS) { items.push("... " + (keys.length - MAX_ITEMS) + " more properties"); break; }
        items.push(propertyKey(key) + ": " + formatProperty(value, key, depth, seen));
      }
      const label = prefix ?? objectPrefix(value);
      if (items.length === 0) return label + "{}";
      return group(label, "{", "}", items, depth);
    }

    // Getters are named rather than called, as Node.js does, and a
    // namespace binding read before it is initialized throws.
    function formatProperty(value, key, depth, seen) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.get !== undefined && descriptor.set !== undefined) return "[Getter/Setter]";
        if (descriptor?.get !== undefined) return "[Getter]";
        if (descriptor?.set !== undefined) return "[Setter]";
        return format(value[key], depth + 1, seen);
      } catch {
        return "<uninitialized>";
      }
    }

    function objectPrefix(value) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === null) return "[Object: null prototype] ";
      const name = constructorName(value);
      return name === undefined || name === "Object" ? "" : name + " ";
    }

    function constructorName(value) {
      try {
        const name = value.constructor?.name;
        return typeof name === "string" && name !== "" ? name : undefined;
      } catch {
        return undefined;
      }
    }

    function listItems(values, depth, seen) {
      const items = values.slice(0, MAX_ITEMS).map((item) => format(item, depth + 1, seen));
      if (values.length > MAX_ITEMS) items.push("... " + (values.length - MAX_ITEMS) + " more items");
      return items;
    }

    function group(prefix, open, close, items, depth) {
      if (items.length === 0) return prefix + open + close;
      const single = prefix + open + " " + items.join(", ") + " " + close;
      if (single.length <= LINE_WIDTH && !single.includes("\\n")) return single;
      const pad = "  ".repeat(depth + 1);
      const lines = items.map((item) => pad + item.split("\\n").join("\\n" + pad));
      return prefix + open + "\\n" + lines.join(",\\n") + "\\n" + "  ".repeat(depth) + close;
    }

    function propertyKey(key) {
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
    }

    function quote(text) {
      return "'" + text
        .replace(/\\\\/g, "\\\\\\\\")
        .replace(/'/g, "\\\\'")
        .replace(/\\n/g, "\\\\n")
        .replace(/\\r/g, "\\\\r")
        .replace(/\\t/g, "\\\\t") + "'";
    }
  `;
}

/**
 * The source of `cf:computer`, which re-exports the lookups.
 *
 * @param introspectionImport - The path from `cf:computer` to the introspection module.
 * @returns The module's source.
 */
export function computerModuleSource(introspectionImport: string): string {
  return `export { docs, types } from ${JSON.stringify(introspectionImport)};\n`;
}
