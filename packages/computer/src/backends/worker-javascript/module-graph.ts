import { parse } from "acorn";

import type { WorkspaceRuntimeCapability } from "../../runtime/capability.js";
import type {
  WorkspaceModule,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeLoader,
} from "../../runtime/types.js";

export type JavaScriptModuleMap = WorkspaceRuntimeLoader extends {
  load(code: { modules: infer Modules }): unknown;
}
  ? Modules
  : never;

const ENTRY_BASENAME = "__workspace_entry__.js";
const RUNNER_MODULE = "workspace-runtime-runner.js";
const CAPABILITIES_MODULE = "workspace-capabilities.js";
// Configured and host modules are stored once, here. The Loader
// resolves a bare import next to the importing file and has no
// node_modules lookup, so every import of one of them is rewritten to a
// relative path that points here. Relative paths are the only form both
// the legacy and the new Loader module registry resolve the same way.
const MODULES_DIRECTORY = "__modules__";
// Installed in every execution and backed by the Workspace. No module
// in the `modules` option may use these names.
const BUILT_IN_MODULES = ["node:fs", "node:fs/promises"] as const;
const HOST_SPECIFIER = /^ws:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// `default` would turn the function into the default export, and a
// `then` export makes the module namespace look like a promise to
// `await import(...)`.
const RESERVED_EXPORT_NAMES = new Set(["default", "then"]);

/** The `modules` option, parsed once when the backend is constructed. */
export interface ParsedModules {
  readonly source: Readonly<Record<string, string>>;
  readonly host: ReadonlyMap<string, WorkspaceModuleFactory>;
  /** One markdown bullet per importable module, for a model. */
  readonly description: string;
}

const FILESYSTEM_DESCRIPTION =
  "- `node:fs/promises` (also `node:fs`): the workspace's files. `readFile`, `writeFile`, `mkdir`, `rm`, `readdir`, `stat`, `lstat`, `readlink`, `symlink`, `chmod`, and `access`. Async only.";

/**
 * Parse the backend's `modules` option: split it into bundled source
 * and host module factories, check every specifier and every object's
 * export names, and describe each module for a model. A factory's
 * export names are checked when the backend connects and it runs.
 *
 * @param modules - The modules passed to the backend.
 * @returns Source modules, host module factories, and their description.
 * @throws When a specifier or an object's export names are not allowed.
 *   The host configured the backend wrongly and no execution can use it.
 */
export function parseModules(modules: Readonly<Record<string, WorkspaceModule>>): ParsedModules {
  const source: Record<string, string> = Object.create(null);
  const host = new Map<string, WorkspaceModuleFactory>();
  const lines = [FILESYSTEM_DESCRIPTION];
  for (const [specifier, module] of Object.entries(modules)) {
    const name = `\`${specifier}\``;
    if (BUILT_IN_MODULES.some((builtIn) => builtIn === specifier)) {
      throw new Error(`Module ${JSON.stringify(specifier)} is built in and cannot be replaced.`);
    }
    if (typeof module === "string") {
      if (specifier.startsWith("ws:")) {
        throw new Error(
          `Module ${JSON.stringify(specifier)} uses the ws:* namespace, which is only for host modules.`,
        );
      }
      if (specifier.includes("/") || isInternalModuleName(specifier)) {
        throw new Error(`Module ${JSON.stringify(specifier)} uses a reserved module name.`);
      }
      source[specifier] = module;
      lines.push(`- ${name}: a bundled library.`);
      continue;
    }
    if (!HOST_SPECIFIER.test(specifier)) {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} must use a simple ws:* name, such as "ws:git".`,
      );
    }
    if (typeof module === "function") {
      host.set(specifier, module);
      lines.push(`- ${name}: ${module.description ?? "a host module."}`);
      continue;
    }
    if (module === null || typeof module !== "object" || Array.isArray(module)) {
      throw new Error(
        `Module ${JSON.stringify(specifier)} must be source text, an object of functions, or a factory.`,
      );
    }
    assertHostModuleExports(specifier, module);
    host.set(specifier, () => module);
    const exports = Object.keys(module).map((key) => `\`${key}\``);
    lines.push(`- ${name}: exports ${exports.join(", ")}.`);
  }
  return { source, host, description: lines.join("\n") };
}

/**
 * Check the functions a host module exports.
 *
 * @param specifier - The module's specifier, for error messages.
 * @param functions - The module's functions.
 * @throws When the module exports nothing, a name is not allowed, or a
 *   value is not a function.
 */
export function assertHostModuleExports(
  specifier: string,
  functions: WorkspaceModuleFunctions,
): void {
  const names = Object.keys(functions);
  if (names.length === 0) {
    throw new Error(`Host module ${JSON.stringify(specifier)} must export a function.`);
  }
  for (const name of names) {
    if (!EXPORT_NAME.test(name) || RESERVED_EXPORT_NAMES.has(name)) {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} export ${JSON.stringify(name)} must be a JavaScript identifier other than "default" or "then".`,
      );
    }
    if (typeof functions[name] !== "function") {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} export ${JSON.stringify(name)} must be a function.`,
      );
    }
  }
}

export interface BuildModuleGraphOptions {
  source: string;
  cwd: string;
  capability: WorkspaceRuntimeCapability;
  configuredModules: Readonly<Record<string, string>>;
  hostModules: ReadonlyMap<string, WorkspaceModuleFunctions>;
  maxSourceBytes: number;
  maxCapabilityBytes: number;
  maxModules?: number;
  maxDepth?: number;
}

/**
 * Prepare the backend's source modules for the module directory, once
 * per backend handle: check what each one imports, and point its host
 * module imports at the module directory.
 *
 * A source module is stored beside the other configured modules rather
 * than beside the caller's files, so it may import them, host modules,
 * and built-in modules, but not Workspace files.
 *
 * @param sources - Source modules by specifier.
 * @param hostModules - The specifiers of the backend's host modules.
 * @returns Each source module, ready to store in the module directory.
 * @throws When a source module is not valid JavaScript, or imports a
 *   path that is not another configured module or a host module that is
 *   not configured.
 */
export function prepareSourceModules(
  sources: Readonly<Record<string, string>>,
  hostModules: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const prepared: Record<string, string> = Object.create(null);
  for (const [specifier, source] of Object.entries(sources)) {
    let sites: ImportSite[];
    try {
      sites = importSites(source, { allowComputed: true });
    } catch (error) {
      throw new Error(`Configured module ${JSON.stringify(specifier)} is not valid JavaScript.`, {
        cause: error,
      });
    }
    const edits: ImportSite[] = [];
    for (const site of sites) {
      const imported = site.specifier;
      if (imported.startsWith("ws:")) {
        if (!hostModules.has(imported)) {
          throw new Error(
            `Configured module ${JSON.stringify(specifier)} imports ${JSON.stringify(imported)}, which is not configured.`,
          );
        }
        // The new registry reads "ws:x" as a URL with its own scheme, so
        // only the relative form finds the stored host module.
        edits.push({ ...site, specifier: `./${imported}` });
        continue;
      }
      if (imported.startsWith(".") || imported.startsWith("/")) {
        const sibling = imported.startsWith("./") ? imported.slice(2) : undefined;
        if (sibling === undefined || !Object.hasOwn(sources, sibling)) {
          throw new Error(
            `Configured module ${JSON.stringify(specifier)} imports ${JSON.stringify(imported)}, which is not a configured module.`,
          );
        }
      }
    }
    prepared[specifier] = rewriteImports(source, edits);
  }
  return prepared;
}

export async function buildModuleGraph(options: BuildModuleGraphOptions) {
  const cwd = normalizePath(await options.capability.resolveConfined(options.cwd, true));
  const entryPath = `${cwd === "/" ? "" : cwd}/${ENTRY_BASENAME}`;
  const entryName = moduleName(entryPath);
  const modules: Record<string, string | { js?: string }> = Object.assign(Object.create(null), {
    [CAPABILITIES_MODULE]: capabilitiesModule(options.maxCapabilityBytes),
  });
  const seen = new Set<string>();
  let totalBytes = new TextEncoder().encode(options.source).byteLength;
  const maxModules = options.maxModules ?? 128;
  const maxDepth = options.maxDepth ?? 32;
  const storedName = (specifier: string) => `${MODULES_DIRECTORY}/${specifier}`;

  async function visit(path: string, source: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new Error(`Workspace JavaScript import depth exceeds ${maxDepth}.`);
    const name = moduleName(path);
    if (seen.has(name)) return;
    seen.add(name);
    if (seen.size > maxModules) {
      throw new Error(`Workspace JavaScript module graph exceeds ${maxModules} modules.`);
    }

    const edits: ImportSite[] = [];
    for (const site of importSites(source, { allowComputed: false })) {
      const specifier = site.specifier;
      if (BUILT_IN_MODULES.some((builtIn) => builtIn === specifier)) continue;
      if (
        options.hostModules.has(specifier) ||
        Object.hasOwn(options.configuredModules, specifier)
      ) {
        edits.push({ ...site, specifier: relativeSpecifier(name, storedName(specifier)) });
        continue;
      }
      if (specifier === CAPABILITIES_MODULE) {
        throw new Error(`Module ${JSON.stringify(specifier)} is reserved for Workspace internals.`);
      }
      if (specifier.startsWith("ws:")) {
        throw new Error(
          `Module ${JSON.stringify(specifier)} is not configured. Add it to the backend's modules option.`,
        );
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const absolute = specifier.startsWith("/");
        const resolved = absolute ? normalizePath(specifier) : resolveRelative(path, specifier);
        const childName = moduleName(resolved);
        if (isInternalModuleName(childName)) {
          throw new Error(
            `Module ${JSON.stringify(childName)} is reserved for Workspace internals.`,
          );
        }
        // The new registry resolves "/x" outside the Worker's bundle, so
        // an absolute import becomes a path relative to its importer.
        if (absolute) edits.push({ ...site, specifier: relativeSpecifier(name, childName) });
        if (seen.has(childName)) continue;
        const stat = await options.capability.stat(resolved);
        if (totalBytes + stat.size > options.maxSourceBytes) {
          throw new Error(
            `Workspace JavaScript module graph exceeds ${options.maxSourceBytes} source bytes.`,
          );
        }
        const child = await options.capability.readFile(resolved);
        totalBytes += new TextEncoder().encode(child).byteLength;
        if (totalBytes > options.maxSourceBytes) {
          throw new Error(
            `Workspace JavaScript module graph exceeds ${options.maxSourceBytes} source bytes.`,
          );
        }
        await visit(resolved, child, depth + 1);
        continue;
      }
      throw new Error(
        `Module ${JSON.stringify(specifier)} is not configured for the worker-javascript backend.`,
      );
    }
    modules[name] = rewriteImports(source, edits);
  }

  await visit(entryPath, options.source, 0);

  // node:* specifiers are resolved by name in both registries, so they
  // keep their exact keys.
  modules["node:fs/promises"] = { js: nodeFsPromisesModule() };
  modules["node:fs"] = { js: nodeFsModule() };

  const toCapabilities = relativeSpecifier(storedName("module"), CAPABILITIES_MODULE);
  for (const [specifier, functions] of options.hostModules) {
    modules[storedName(specifier)] = {
      js: hostModule(toCapabilities, specifier, Object.keys(functions)),
    };
  }
  for (const [specifier, source] of Object.entries(options.configuredModules)) {
    modules[storedName(specifier)] = { js: source };
  }

  return { entryName, modules };
}

// An import written as a string literal, and where that literal sits in
// the source, quotes included.
interface ImportSite {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

// Every import, re-export, and dynamic import written as a string
// literal. Caller source must be fully analyzable, so a computed dynamic
// import is an error there. Configured modules may use one; it resolves
// at run time.
function importSites(source: string, options: { allowComputed: boolean }): ImportSite[] {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const found: ImportSite[] = [];
  walk(ast, (node) => {
    const item = node as {
      type?: string;
      source?: { type?: string; value?: unknown; start: number; end: number } | null;
    };
    if (
      item.type !== "ImportDeclaration" &&
      item.type !== "ExportNamedDeclaration" &&
      item.type !== "ExportAllDeclaration" &&
      item.type !== "ImportExpression"
    ) {
      return;
    }
    const literal = item.source;
    if (literal?.type === "Literal" && typeof literal.value === "string") {
      found.push({ specifier: literal.value, start: literal.start, end: literal.end });
    } else if (item.type === "ImportExpression" && !options.allowComputed) {
      throw new Error("Workspace JavaScript dynamic imports must use a string literal.");
    }
  });
  return found;
}

// Replace each edited import literal with its new specifier, working from
// the end so earlier positions stay valid.
function rewriteImports(source: string, edits: readonly ImportSite[]): string {
  let rewritten = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${JSON.stringify(edit.specifier)}${rewritten.slice(edit.end)}`;
  }
  return rewritten;
}

// The path from one module to another, starting with "./" or "../".
function relativeSpecifier(fromName: string, toName: string) {
  const from = directoryName(fromName).split("/").filter(Boolean);
  const to = toName.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  const rest = to.slice(common).join("/");
  const up = from.length - common;
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  if (value === null || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else walk(child, visit);
  }
}

function normalizePath(path: string) {
  if (!path.startsWith("/")) throw new Error("Workspace JavaScript paths must be absolute.");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function resolveRelative(importer: string, specifier: string) {
  const base = importer.slice(0, importer.lastIndexOf("/")) || "/";
  const parts = `${base}/${specifier}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

function moduleName(path: string) {
  return path.replace(/^\/+/, "");
}

function directoryName(name: string) {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? "" : name.slice(0, slash);
}

function isInternalModuleName(name: string) {
  return (
    name === CAPABILITIES_MODULE ||
    name === RUNNER_MODULE ||
    name === ENTRY_BASENAME ||
    name === MODULES_DIRECTORY ||
    name.startsWith(`${MODULES_DIRECTORY}/`) ||
    name.endsWith(`/${CAPABILITIES_MODULE}`) ||
    name.endsWith(`/${RUNNER_MODULE}`) ||
    name.split("/").at(-1)?.startsWith("ws:") === true
  );
}

function capabilitiesModule(maxCapabilityBytes: number) {
  const requestTooLargeMessage = `Workspace capability request exceeds ${maxCapabilityBytes} bytes.`;
  return `
    let host;
    const callKey = Symbol.for("cloudflare.workspace.runtime.call");
    const filesystemMethods = new Set([
      "readFile", "readFileBytes", "writeFile", "mkdir", "rm", "chmod",
      "symlink", "readlink", "readdir", "readdirWithFileTypes", "stat", "lstat", "exists"
    ]);
    // Calls the Workers runtime refused because they ran at module scope.
    // The runner fails the run if any are left, even when the module
    // caught the error, since the work it asked for never happened.
    export const moduleScopeRefusals = [];
    export function install(value) {
      host = value;
      moduleScopeRefusals.length = 0;
      globalThis[callKey] = filesystemCall;
    }
    async function filesystemCall(namespace, method, args) {
      if (namespace !== "fs" || !filesystemMethods.has(method)) {
        throw new Error("The internal Workspace filesystem dispatcher only accepts node:fs operations");
      }
      return call(namespace, method, args);
    }
    // Arguments and results cross as real values through Workers RPC.
    // The host bridge measures and limits them; this early check only
    // spares an obviously oversized request the round trip.
    export async function call(namespace, method, args) {
      if (!host) throw new Error("Workspace capabilities are not installed");
      if (approximateBytes(args) > ${maxCapabilityBytes}) {
        throw new Error(${JSON.stringify(requestTooLargeMessage)});
      }
      let payload;
      try {
        payload = await host.call(namespace + "." + method, args);
      } catch (error) {
        // A module is evaluated outside any request, and the runtime
        // refuses I/O there with an error about request handlers, which
        // this code doesn't have. Name the call and the fix instead.
        if (error instanceof Error && error.message.startsWith("Disallowed operation called within global scope")) {
          const name = namespace === "fs" ? "node:fs" : namespace.slice("host/".length);
          const refused = new Error(
            name + " " + method + " can't run at module scope, where the Workers runtime refuses I/O. " +
            "Call it from inside the default-exported function."
          );
          moduleScopeRefusals.push(refused);
          throw refused;
        }
        throw error;
      }
      if (payload.error !== undefined) {
        const error = new Error(payload.error.message);
        if (payload.error.code !== undefined) error.code = payload.error.code;
        if (payload.error.path !== undefined) error.path = payload.error.path;
        throw error;
      }
      return payload.result;
    }
    function approximateBytes(value, seen = new Set()) {
      if (typeof value === "string") return value.length;
      if (value instanceof Uint8Array) return value.byteLength;
      if (!value || typeof value !== "object") return 8;
      if (seen.has(value)) throw new Error("Workspace capability request values must be acyclic.");
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((item) => ["", item]) : Object.entries(value);
      const total = entries.reduce((sum, [key, item]) => sum + key.length + approximateBytes(item, seen), 8);
      seen.delete(value);
      return total;
    }
  `;
}

// Exports go through `export { local as name }` rather than
// `export const name`, so a reserved word such as `delete` still works
// as an export name.
function hostModule(capabilitiesImport: string, specifier: string, names: readonly string[]) {
  const namespace = JSON.stringify(`host/${specifier}`);
  return `
    import { call } from ${JSON.stringify(capabilitiesImport)};
    ${names.map((name, index) => `const fn${index} = (...args) => call(${namespace}, ${JSON.stringify(name)}, args);`).join("\n")}
    export { ${names.map((name, index) => `fn${index} as ${name}`).join(", ")} };
  `;
}

function nodeFsPromisesModule() {
  return `
    const callKey = Symbol.for("cloudflare.workspace.runtime.call");
    const invoke = (method, args) => {
      const call = globalThis[callKey];
      if (!call) throw new Error("Workspace filesystem capability is not installed");
      return call("fs", method, args);
    };
    const encoding = (options) => typeof options === "string" ? options : options?.encoding;
    export const readFile = (path, options) => {
      const requested = encoding(options);
      if (requested === undefined || requested === null) return invoke("readFileBytes", [path]);
      if (requested === "utf8" || requested === "utf-8") return invoke("readFile", [path]);
      return Promise.reject(new TypeError("Workspace node:fs readFile supports only utf8 encoding"));
    };
    export const writeFile = (path, data, options) => invoke("writeFile", [path, data, options]);
    export const mkdir = (path, options) => invoke("mkdir", [path, options]);
    export const rm = (path, options) => invoke("rm", [path, options]);
    export const chmod = (path, mode) => invoke("chmod", [path, mode]);
    export const symlink = (target, path) => invoke("symlink", [target, path]);
    export const readlink = (path) => invoke("readlink", [path]);
    export const readdir = async (path = ".", options) => {
      if (!options?.withFileTypes) return invoke("readdir", [path]);
      const entries = await invoke("readdirWithFileTypes", [path]);
      return entries.map((entry) => dirent(entry.name, entry));
    };
    export const stat = async (path) => stats(await invoke("stat", [path]));
    export const lstat = async (path) => stats(await invoke("lstat", [path]));
    export const access = async (path) => {
      if (!await invoke("exists", [path])) {
        const error = new Error("ENOENT: no such file or directory, access '" + path + "'");
        error.code = "ENOENT";
        error.path = path;
        throw error;
      }
    };
    function stats(value) {
      return Object.assign({}, value, {
        isFile: () => value.isFile,
        isDirectory: () => value.isDirectory,
        isSymbolicLink: () => value.isSymbolicLink,
      });
    }
    function dirent(name, value) {
      return {
        name,
        isFile: () => value.isFile,
        isDirectory: () => value.isDirectory,
        isSymbolicLink: () => value.isSymbolicLink,
      };
    }
    const promises = { readFile, writeFile, mkdir, rm, chmod, symlink, readlink, readdir, stat, lstat, access };
    export default promises;
  `;
}

function nodeFsModule() {
  return `${nodeFsPromisesModule()}\nexport { default as promises } from "node:fs/promises";`;
}
