import { parse } from "acorn";

import type { WorkspaceRuntimeCapability } from "../../runtime/capability";
import { type CodemodeModule, isCodemodeModule } from "../../runtime/codemode-module";
import { assertExportNames, assertHostModuleExports } from "../../runtime/export-names";
import type {
  WorkspaceModule,
  WorkspaceModuleFactory,
  WorkspaceRuntimeLoader,
} from "../../runtime/types";
import { DURABLE_MODULE, durableRuntimeModule } from "./durable-runtime";

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

// Node.js built-ins the Dynamic Worker provides itself under
// `nodejs_compat`. They only compute: none reaches the network, the
// process, or a filesystem, so code imports them unchanged. Workerd has
// many more, but those either duplicate what the Workspace provides,
// such as `node:fs`, or are stubs that throw when called.
const NODE_MODULES = [
  "path",
  "path/posix",
  "url",
  "util",
  "util/types",
  "events",
  "buffer",
  "assert",
  "assert/strict",
  "string_decoder",
  "querystring",
  "stream",
  "stream/promises",
  "stream/web",
  "crypto",
  "zlib",
  "timers",
  "timers/promises",
  "async_hooks",
  "diagnostics_channel",
] as const;

/** Whether `flags` give a Dynamic Worker the Node.js built-ins. */
export function hasNodeModules(flags: readonly string[]): boolean {
  return flags.includes("nodejs_compat") || flags.includes("nodejs_compat_v2");
}

const TOP_LEVEL_NODE_MODULES = NODE_MODULES.filter((name) => !name.includes("/"))
  .map((name) => `\`node:${name}\``)
  .join(", ");

/** One markdown bullet listing the Node.js built-ins, for a model. */
export const NODE_MODULES_DESCRIPTION = `- Node.js built-ins: ${TOP_LEVEL_NODE_MODULES}, with subpaths such as \`node:stream/promises\`. Bare names such as \`path\` work too.`;

// The `node:` form of a Node.js built-in the backend allows, from either
// spelling, or undefined for anything else.
function nodeModule(specifier: string): string | undefined {
  const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return NODE_MODULES.some((allowed) => allowed === name) ? `node:${name}` : undefined;
}
/** The scheme of host module specifiers unless the backend's `scheme` says otherwise. */
export const DEFAULT_SCHEME = "codemode";

const SCHEME = /^[a-z][a-z0-9-]*$/;
// Schemes the Workers runtime or URLs already give a meaning, such as
// `node:path` or `https://...`. Modules under one would shadow those, or
// be mistaken for them by the code that imports them.
const RESERVED_SCHEMES = new Set([
  "node",
  "cloudflare",
  "workerd",
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
  "data",
  "blob",
  "javascript",
]);

/**
 * Check a backend's `scheme`.
 *
 * @param scheme - The scheme, without its colon.
 * @throws When it is not a lowercase letter followed by lowercase letters,
 *   digits, or `-`, or is a scheme the runtime or URLs already use.
 */
export function assertScheme(scheme: string): void {
  if (typeof scheme !== "string" || !SCHEME.test(scheme)) {
    throw new Error(
      `CodemodeBackend scheme must be a lowercase letter followed by lowercase letters, digits, or "-", such as "codemode", not ${JSON.stringify(scheme)}.`,
    );
  }
  if (RESERVED_SCHEMES.has(scheme)) {
    throw new Error(
      `CodemodeBackend scheme ${JSON.stringify(scheme)} is reserved: the Workers runtime or URL parsing already gives it a meaning.`,
    );
  }
}

// A simple specifier under the scheme, such as `codemode:git`. The scheme
// is checked first, so it has no characters a pattern treats specially.
function hostSpecifier(scheme: string): RegExp {
  return new RegExp(`^${scheme}:[A-Za-z0-9][A-Za-z0-9._-]*$`);
}

/** The `modules` option, parsed once when the backend is constructed. */
export interface ParsedModules {
  readonly source: Readonly<Record<string, string>>;
  readonly host: ReadonlyMap<string, WorkspaceModuleFactory>;
  readonly codemode: ReadonlyMap<string, CodemodeModule>;
  /** One markdown bullet per importable module, for a model. */
  readonly description: string;
}

const FILESYSTEM_DESCRIPTION =
  "- `node:fs/promises` (also `node:fs`): the workspace's files. `readFile`, `writeFile`, `mkdir`, `rm`, `readdir`, `stat`, `lstat`, `readlink`, `symlink`, `chmod`, and `access`. Async only.";

/**
 * Parse the backend's `modules` option: split it into bundled source,
 * host module factories, and scoped host modules, check every
 * specifier and the export names of every object and codemode module,
 * and describe each module for a model. A factory's export names are
 * checked when the backend connects and it runs.
 *
 * @param modules - The modules passed to the backend.
 * @param scheme - The scheme host modules use, such as `codemode`.
 * @returns Source modules, host module factories, codemode modules, and
 *   their description.
 * @throws When a specifier or an object's export names are not allowed.
 *   The host configured the backend wrongly and no execution can use it.
 */
export function parseModules(
  modules: Readonly<Record<string, WorkspaceModule>>,
  scheme: string = DEFAULT_SCHEME,
): ParsedModules {
  const prefix = `${scheme}:`;
  const simple = hostSpecifier(scheme);
  const example = JSON.stringify(`${scheme}:git`);
  const source: Record<string, string> = Object.create(null);
  const host = new Map<string, WorkspaceModuleFactory>();
  const codemode = new Map<string, CodemodeModule>();
  const lines: Array<string | (() => string)> = [FILESYSTEM_DESCRIPTION];
  for (const [specifier, module] of Object.entries(modules)) {
    const name = `\`${specifier}\``;
    if (BUILT_IN_MODULES.some((builtIn) => builtIn === specifier)) {
      throw new Error(`Module ${JSON.stringify(specifier)} is built in and cannot be replaced.`);
    }
    if (typeof module === "string") {
      if (specifier.startsWith(prefix)) {
        // Source the host provides under its own namespace, such as a facade over its host
        // modules that exports objects, which host modules can't. Same naming rule as theirs.
        if (!simple.test(specifier)) {
          throw new Error(
            `Module ${JSON.stringify(specifier)} must use a simple ${prefix}* name, such as ${example}.`,
          );
        }
        source[specifier] = module;
        lines.push(`- ${name}: a library the host provides.`);
        continue;
      }
      if (specifier.includes("/") || isInternalModuleName(specifier, scheme)) {
        throw new Error(`Module ${JSON.stringify(specifier)} uses a reserved module name.`);
      }
      source[specifier] = module;
      lines.push(`- ${name}: a bundled library.`);
      continue;
    }
    if (!simple.test(specifier)) {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} must use a simple ${prefix}* name, such as ${example}.`,
      );
    }
    if (isCodemodeModule(module)) {
      assertExportNames(specifier, module.exports);
      codemode.set(specifier, module);
      const exports = module.exports.map((key) => `\`${key}\``).join(", ");
      lines.push(`- ${name}: ${module.description ?? `exports ${exports}.`}`);
      continue;
    }
    if (typeof module === "function") {
      host.set(specifier, module);
      lines.push(() => `- ${name}: ${module.description ?? "a host module."}`);
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
  return {
    source,
    host,
    codemode,
    get description() {
      return lines.map((line) => (typeof line === "string" ? line : line())).join("\n");
    },
  };
}

export { assertHostModuleExports };

export interface BuildModuleGraphOptions {
  source: string;
  cwd: string;
  capability: WorkspaceRuntimeCapability;
  configuredModules: Readonly<Record<string, string>>;
  /** Each host module's export names, by specifier. */
  hostModules: ReadonlyMap<string, readonly string[]>;
  /** Host modules whose factory built no functions on this connection, so they are left out. */
  emptyHostModules?: ReadonlySet<string>;
  /** Whether the Dynamic Worker has the Node.js built-ins. */
  nodeModules: boolean;
  maxSourceBytes: number;
  maxCapabilityBytes: number;
  maxModules?: number;
  maxDepth?: number;
  /** The scheme host modules use. Defaults to `codemode`. */
  scheme?: string;
}

/**
 * Prepare the backend's source modules for the module directory, once
 * per backend handle: check what each one imports, and point its
 * imports under the module scheme, such as `codemode:*`, at the module
 * directory.
 *
 * A source module is stored beside the other configured modules rather
 * than beside the caller's files, so it may import them (those under
 * the module scheme by name too), host modules, and built-in modules,
 * but not Workspace files.
 *
 * @param sources - Source modules by specifier.
 * @param hostModules - The specifiers of the backend's host modules.
 * @param scheme - The scheme host modules use, such as `codemode`.
 * @returns Each source module, ready to store in the module directory.
 * @throws When a source module is not valid JavaScript, or imports a
 *   path that is not another configured module or a host module that is
 *   not configured.
 */
export function prepareSourceModules(
  sources: Readonly<Record<string, string>>,
  hostModules: ReadonlySet<string>,
  scheme: string = DEFAULT_SCHEME,
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
      if (imported.startsWith(`${scheme}:`)) {
        if (!hostModules.has(imported) && !Object.hasOwn(sources, imported)) {
          throw new Error(
            `Configured module ${JSON.stringify(specifier)} imports ${JSON.stringify(imported)}, which is not configured.`,
          );
        }
        // The new registry reads "codemode:x" as a URL with its own scheme, so
        // only the relative form finds the stored module.
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
    [DURABLE_MODULE]: durableRuntimeModule(),
  });
  const seen = new Set<string>();
  let totalBytes = new TextEncoder().encode(options.source).byteLength;
  const maxModules = options.maxModules ?? 128;
  const maxDepth = options.maxDepth ?? 32;
  const scheme = options.scheme ?? DEFAULT_SCHEME;
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
      // A bare name becomes its node: form, which both module registries
      // resolve as a built-in.
      const node = options.nodeModules ? nodeModule(specifier) : undefined;
      if (node !== undefined) {
        if (node !== specifier) edits.push({ ...site, specifier: node });
        continue;
      }
      if (specifier === CAPABILITIES_MODULE || specifier === DURABLE_MODULE) {
        throw new Error(`Module ${JSON.stringify(specifier)} is reserved for Workspace internals.`);
      }
      if (options.emptyHostModules?.has(specifier)) {
        throw new Error(
          `Module ${JSON.stringify(specifier)} exports nothing on this backend: its factory built no functions when the backend connected.`,
        );
      }
      if (specifier.startsWith(`${scheme}:`)) {
        throw new Error(
          `Module ${JSON.stringify(specifier)} is not configured. Add it to the backend's modules option.`,
        );
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const absolute = specifier.startsWith("/");
        const resolved = absolute ? normalizePath(specifier) : resolveRelative(path, specifier);
        const childName = moduleName(resolved);
        if (isInternalModuleName(childName, scheme)) {
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
        `Module ${JSON.stringify(specifier)} is not configured for the codemode backend.`,
      );
    }
    modules[name] = rewriteImports(source, edits);
  }

  assertDefaultExport(options.source);
  await visit(entryPath, options.source, 0);

  // node:* specifiers are resolved by name in both registries, so they
  // keep their exact keys.
  modules["node:fs/promises"] = { js: nodeFsPromisesModule() };
  modules["node:fs"] = { js: nodeFsModule() };

  const toCapabilities = relativeSpecifier(storedName("module"), CAPABILITIES_MODULE);
  for (const [specifier, names] of options.hostModules) {
    modules[storedName(specifier)] = {
      js: hostModule(toCapabilities, specifier, names),
    };
  }
  for (const [specifier, source] of Object.entries(options.configuredModules)) {
    modules[storedName(specifier)] = { js: source };
  }

  return { entryName, modules };
}

// The run's result comes from the entry module's default export, so a
// module without one would complete with nothing to show. Fail before
// loading it, and name any other exports, since a model that writes
// `export function main` meant one of them.
function assertDefaultExport(source: string): void {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const named: string[] = [];
  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") return;
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers) {
      const exported = specifier.exported;
      const name = exported.type === "Identifier" ? exported.name : String(exported.value);
      if (name === "default") return;
      named.push(name);
    }
    const declaration = node.declaration;
    if (declaration?.type === "VariableDeclaration") {
      for (const variable of declaration.declarations) {
        if (variable.id.type === "Identifier") named.push(variable.id.name);
      }
    } else if (declaration?.id) {
      named.push(declaration.id.name);
    }
  }
  const shape =
    'Put the work in `export default async function (input) { ... }`, or re-export one with `export { default } from "./main.js"`.';
  if (named.length === 0) {
    throw new Error(`The module has no default export, so there is nothing to run. ${shape}`);
  }
  const list = named.map((name) => `\`${name}\``);
  const exports =
    list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
  throw new Error(
    `The module exports ${exports} but no default, so there is nothing to run. ${shape}`,
  );
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

function isInternalModuleName(name: string, scheme: string) {
  return (
    name === CAPABILITIES_MODULE ||
    name === DURABLE_MODULE ||
    name === RUNNER_MODULE ||
    name === ENTRY_BASENAME ||
    name === MODULES_DIRECTORY ||
    name.startsWith(`${MODULES_DIRECTORY}/`) ||
    name.endsWith(`/${CAPABILITIES_MODULE}`) ||
    name.endsWith(`/${DURABLE_MODULE}`) ||
    name.endsWith(`/${RUNNER_MODULE}`) ||
    name.split("/").at(-1)?.startsWith(`${scheme}:`) === true
  );
}

/**
 * The generated modules every graph carries. A durable execution
 * compares them to tell whether the runtime changed under it.
 */
export function internalModuleSources(maxCapabilityBytes: number): string[] {
  return [
    capabilitiesModule(maxCapabilityBytes),
    durableRuntimeModule(),
    nodeFsPromisesModule(),
    nodeFsModule(),
  ];
}

function capabilitiesModule(maxCapabilityBytes: number) {
  const requestTooLargeMessage = `Workspace capability request exceeds ${maxCapabilityBytes} bytes.`;
  return `
    import { deliver, durable, failed, request, takeLog } from "${DURABLE_MODULE}";
    let host;
    // The most bytes of a stream one call carries, inside the request limit.
    const STREAM_BYTES = Math.max(1, Math.floor(${maxCapabilityBytes} / 2));
    // Numbers a run's stream and signal arguments, the same on every replay.
    let streamCount = 0;
    let signalCount = 0;
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
      streamCount = 0;
      signalCount = 0;
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
      // A replayable run's calls can't carry a stream, so a stream passed to a codemode module
      // goes as a marker, and its chunks follow in calls of their own. No run's calls can carry
      // an AbortSignal, so one goes as a marker too, and its abort follows as a call.
      let streams;
      let signals;
      if (namespace.startsWith("host/")) {
        streams = durable() ? [] : undefined;
        signals = [];
        args = swapArguments(args, streams, signals);
      }
      if (approximateBytes(args) > ${maxCapabilityBytes}) {
        throw new Error(${JSON.stringify(requestTooLargeMessage)});
      }
      let payload;
      request();
      try {
        const sent = host.call(namespace + "." + method, args, takeLog());
        // After the call they belong to, so the host has made their streams.
        for (const [id, stream] of streams ?? []) void pump(id, stream);
        for (const [id, signal] of signals ?? []) forwardAbort(id, signal);
        payload = await sent;
      } catch (error) {
        failed();
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
      // A replayable run sees responses in the order it first saw them.
      payload = await deliver(payload);
      if (payload.error !== undefined) {
        // A codemode error keeps its standard name and its own properties.
        const name = payload.error.name;
        const ErrorType = typeof name === "string" && Object.hasOwn(errorTypes, name) ? errorTypes[name] : Error;
        const error = new ErrorType(payload.error.message);
        if (payload.error.props !== undefined && payload.error.props !== null) {
          for (const [key, value] of Object.entries(payload.error.props)) {
            if (key !== "message" && key !== "stack") error[key] = value;
          }
        }
        if (payload.error.code !== undefined) error.code = payload.error.code;
        if (payload.error.path !== undefined) error.path = payload.error.path;
        throw error;
      }
      return payload.objects === undefined ? payload.result : reviveObjects(payload.result, payload.objects);
    }
    // A codemode module's objects arrive as markers, objects with one NUL-prefixed key,
    // with their refs listed beside the result. Each becomes a proxy whose
    // methods are host calls on that ref.
    const objectMarker = "\\u0000codemode";
    const errorTypes = { TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
    function reviveObjects(value, objects) {
      const proxies = objects.map((object) => objectProxy(String(object.ref), object.members, object.fields));
      const visit = (item) => {
        if (Array.isArray(item)) return item.map(visit);
        if (item === null || typeof item !== "object") return item;
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) return item;
        const keys = Object.keys(item);
        if (keys.length === 1 && keys[0] === objectMarker && typeof item[objectMarker] === "number") {
          return proxies[item[objectMarker]];
        }
        const copy = {};
        for (const key of keys) {
          Object.defineProperty(copy, key, { value: visit(item[key]), enumerable: true, writable: true, configurable: true });
        }
        return copy;
      };
      return visit(value);
    }
    // An object's fields are its values; its promises and streams are made the first time code
    // reads them, and work through host calls on \`@<op>:<member>\`. A call that would have waited
    // past its deadline answers to say so, and is made again.
    function objectProxy(ref, members, fields) {
      let released;
      const release = () => {
        released ??= Promise.resolve(host?.release(ref)).catch(() => undefined);
        return released;
      };
      const namespace = "host/" + ref;
      const disposedError = () => new Error("This object was disposed, so its methods can't be called.");
      const memberCall = async (op, key, args, waiting) => {
        for (;;) {
          if (released !== undefined) throw disposedError();
          const answer = await call(namespace, "@" + op + ":" + key, args);
          if (!waiting(answer)) return answer;
        }
      };
      const made = new Map();
      const member = (key, kind) => {
        if (made.has(key)) return made.get(key);
        let value;
        if (kind === "promise") {
          value = memberCall("await", key, [], (answer) => answer?.done === false).then((answer) => answer.value);
          // Rejects for code that awaits it, and isn't unhandled for code that doesn't.
          value.catch(() => {});
        } else if (kind === "readable") {
          value = new ReadableStream({
            async pull(controller) {
              const answer = await memberCall("read", key, [], (answer) => answer?.again === true);
              if (answer?.done === true) controller.close();
              else controller.enqueue(answer.chunk);
            },
            cancel: (reason) =>
              released !== undefined
                ? undefined
                : call(namespace, "@cancel:" + key, [reason === undefined ? null : String(reason)]).then(() => undefined, () => undefined),
          }, { highWaterMark: 0 }); // Read from the host only as code reads.
        } else if (kind === "writable") {
          const again = (answer) => answer?.again === true;
          value = new WritableStream({
            async write(chunk) {
              const bytes = toBytes(chunk);
              for (let at = 0; at < bytes.byteLength || at === 0; at += STREAM_BYTES) {
                await memberCall("write", key, [bytes.subarray(at, at + STREAM_BYTES)], again);
                if (bytes.byteLength === 0) break;
              }
            },
            close: () => memberCall("close", key, [], again).then(() => undefined),
            abort: (reason) => memberCall("abort", key, [reason === undefined ? null : String(reason)], again).then(() => undefined),
          });
        }
        made.set(key, value);
        return value;
      };
      const methods = new Map();
      return new Proxy(Object.create(null), {
        get(_target, key) {
          if (key === Symbol.dispose) return () => void release();
          if (key === Symbol.asyncDispose) return release;
          // Left alone so awaiting, logging or serializing a proxy doesn't call the host.
          if (typeof key !== "string" || key === "then" || key === "toJSON" || key === "constructor") {
            return undefined;
          }
          if (fields != null && Object.hasOwn(fields, key)) return fields[key];
          if (members != null && Object.hasOwn(members, key)) return member(key, members[key]);
          let method = methods.get(key);
          if (method === undefined) {
            method = (...args) =>
              released !== undefined
                ? Promise.reject(new Error("This object was disposed, so its methods can't be called."))
                : call("host/" + ref, key, args);
            methods.set(key, method);
          }
          return method;
        },
      });
    }
    function toBytes(chunk) {
      if (chunk instanceof Uint8Array) return chunk;
      if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
      if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (typeof chunk === "string") return new TextEncoder().encode(chunk);
      throw new TypeError("A stream to a host module takes bytes or strings.");
    }
    // Replaces each AbortSignal in a call's arguments with a marker, and with \`streams\` each
    // ReadableStream, collecting them to forward.
    function swapArguments(value, streams, signals, seen = new Set()) {
      if (value instanceof AbortSignal) {
        const id = "a" + ++signalCount;
        signals.push([id, value]);
        return { [signalMarker]: id };
      }
      if (streams !== undefined && value instanceof ReadableStream) {
        const id = "s" + ++streamCount;
        streams.push([id, value]);
        return { [streamMarker]: id };
      }
      if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
      // A cycle is left as it is, for the size check to refuse with its own message.
      if (seen.has(value)) return value;
      if (Array.isArray(value)) {
        seen.add(value);
        const items = value.map((item) => swapArguments(item, streams, signals, seen));
        seen.delete(value);
        return items;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;
      seen.add(value);
      const copy = {};
      for (const key of Object.keys(value)) {
        Object.defineProperty(copy, key, { value: swapArguments(value[key], streams, signals, seen), enumerable: true, writable: true, configurable: true });
      }
      seen.delete(value);
      return copy;
    }
    const streamMarker = "\\u0000stream";
    const signalMarker = "\\u0000signal";
    // Sends a signal argument's abort, now if it has already happened.
    function forwardAbort(id, signal) {
      const send = () => {
        const reason = signal.reason;
        const message = reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason);
        call("signal", "abort", message === undefined ? [id] : [id, message]).catch(() => {});
      };
      if (signal.aborted) send();
      else signal.addEventListener("abort", send, { once: true });
    }
    // Sends a stream argument's chunks as \`stream.push\` calls, each once the host has room.
    async function pump(id, stream) {
      const push = async (chunk, failure) => {
        for (;;) {
          const answer = await call("stream", "push", failure === undefined ? [id, chunk] : [id, chunk, failure]);
          if (answer?.again !== true) return answer;
        }
      };
      let reader;
      try {
        reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            await push(null);
            return;
          }
          const bytes = toBytes(value);
          for (let at = 0; at < bytes.byteLength; at += STREAM_BYTES) {
            if ((await push(bytes.subarray(at, at + STREAM_BYTES)))?.closed === true) {
              await reader.cancel().catch(() => {});
              return;
            }
          }
        }
      } catch (error) {
        await push(null, String(error?.message ?? error)).catch(() => {});
        await reader?.cancel(error).catch(() => {});
      }
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
