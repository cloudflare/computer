import { parse } from "acorn";

import type { WorkspaceRuntimeCapability } from "../../runtime/capability.js";
import type { WorkspaceRuntimeLoader } from "../../runtime/types.js";

export type JavaScriptModuleMap = WorkspaceRuntimeLoader extends {
  load(code: { modules: infer Modules }): unknown;
}
  ? Modules
  : never;

const ENTRY_BASENAME = "__workspace_entry__.js";
const RUNNER_MODULE = "workspace-runtime-runner.js";
const CAPABILITIES_MODULE = "workspace-capabilities.js";
const TRUSTED_MODULES = ["node:fs", "node:fs/promises", "ws:git", "ws:artifacts"] as const;

export interface BuildModuleGraphOptions {
  source: string;
  cwd: string;
  capability: WorkspaceRuntimeCapability;
  configuredModules: Record<string, string>;
  trustedModuleNames?: string[];
  maxSourceBytes: number;
  maxCapabilityBytes: number;
  maxModules?: number;
  maxDepth?: number;
}

export async function buildModuleGraph(options: BuildModuleGraphOptions) {
  const cwd = normalizeCwd(await options.capability.resolveConfined(options.cwd, true));
  const entryPath = `${cwd === "/" ? "" : cwd}/${ENTRY_BASENAME}`;
  const entryName = moduleName(entryPath);
  const modules: Record<string, string | { js?: string }> = Object.assign(Object.create(null), {
    [entryName]: options.source,
    [CAPABILITIES_MODULE]: capabilitiesModule(options.maxCapabilityBytes),
  });
  const seen = new Set<string>();
  const directories = new Set<string>([directoryName(entryName)]);
  let totalBytes = new TextEncoder().encode(options.source).byteLength;
  const maxModules = options.maxModules ?? 128;
  const maxDepth = options.maxDepth ?? 32;
  const trustedModuleNames = new Set<string>(TRUSTED_MODULES);
  for (const name of options.trustedModuleNames ?? []) {
    if (
      !/^ws:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
      TRUSTED_MODULES.includes(name as (typeof TRUSTED_MODULES)[number])
    ) {
      throw new Error(
        `Trusted module ${JSON.stringify(name)} must use a unique simple reserved ws:* name.`,
      );
    }
    trustedModuleNames.add(name);
  }

  async function visit(path: string, source: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new Error(`Workspace JavaScript import depth exceeds ${maxDepth}.`);
    const name = moduleName(path);
    if (seen.has(name)) return;
    seen.add(name);
    directories.add(directoryName(name));
    if (seen.size > maxModules) {
      throw new Error(`Workspace JavaScript module graph exceeds ${maxModules} modules.`);
    }

    for (const specifier of imports(source)) {
      if (trustedModuleNames.has(specifier)) continue;
      if (specifier === CAPABILITIES_MODULE) {
        throw new Error(`Module ${JSON.stringify(specifier)} is reserved for Workspace internals.`);
      }
      if (specifier.startsWith("ws:")) {
        throw new Error(`Unknown trusted Workspace module ${JSON.stringify(specifier)}.`);
      }
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(path, specifier);
        const childName = moduleName(resolved);
        if (isInternalModuleName(childName)) {
          throw new Error(
            `Module ${JSON.stringify(childName)} is reserved for Workspace internals.`,
          );
        }
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
        modules[childName] = child;
        await visit(resolved, child, depth + 1);
        continue;
      }
      if (specifier.startsWith("/")) {
        throw new Error(
          `Absolute JavaScript import ${JSON.stringify(specifier)} is not supported; use a relative Workspace import.`,
        );
      }
      if (!Object.hasOwn(options.configuredModules, specifier)) {
        throw new Error(
          `Module ${JSON.stringify(specifier)} is not configured for the worker-javascript backend.`,
        );
      }
    }
  }

  await visit(entryPath, options.source, 0);

  for (const specifier of Object.keys(options.configuredModules)) {
    if (
      trustedModuleNames.has(specifier) ||
      specifier.startsWith("ws:") ||
      specifier === ENTRY_BASENAME ||
      specifier === RUNNER_MODULE ||
      specifier === CAPABILITIES_MODULE ||
      specifier.includes("/")
    ) {
      throw new Error(
        `Configured module ${JSON.stringify(specifier)} uses a reserved module name.`,
      );
    }
  }

  // node:* specifiers use protocol-style resolution and therefore need exact
  // module-map keys rather than the importer-directory aliases used by ws:*.
  modules["node:fs/promises"] = { js: nodeFsPromisesModule() };
  modules["node:fs"] = { js: nodeFsModule() };

  for (const directory of directories) {
    const prefix = directory ? `${directory}/` : "";
    const toCapabilities = relativeModule(directory, CAPABILITIES_MODULE);
    modules[`${prefix}ws:git`] = { js: gitModule(toCapabilities) };
    modules[`${prefix}ws:artifacts`] = { js: artifactsModule(toCapabilities) };
    for (const specifier of options.trustedModuleNames ?? []) {
      modules[`${prefix}${specifier}`] = {
        js: trustedModule(toCapabilities, specifier),
      };
    }
    for (const [specifier, source] of Object.entries(options.configuredModules)) {
      const key = `${prefix}${specifier}`;
      if (key in modules) {
        throw new Error(
          `Configured module ${JSON.stringify(specifier)} collides with ${JSON.stringify(key)}.`,
        );
      }
      modules[key] = { js: source };
    }
  }

  return { entryName, modules };
}

function imports(source: string): string[] {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as {
    body: unknown[];
  };
  const found: string[] = [];
  walk(ast, (node) => {
    const item = node as { type?: string; source?: { type?: string; value?: unknown } };
    if (
      item.type === "ImportDeclaration" ||
      item.type === "ExportNamedDeclaration" ||
      item.type === "ExportAllDeclaration"
    ) {
      if (typeof item.source?.value === "string") found.push(item.source.value);
    }
    if (item.type === "ImportExpression") {
      if (item.source?.type !== "Literal" || typeof item.source.value !== "string") {
        throw new Error("Workspace JavaScript dynamic imports must use a string literal.");
      }
      found.push(item.source.value);
    }
  });
  return found;
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  if (value === null || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else walk(child, visit);
  }
}

function normalizeCwd(cwd: string) {
  if (!cwd.startsWith("/")) throw new Error("Workspace JavaScript cwd must be absolute.");
  const parts: string[] = [];
  for (const part of cwd.split("/")) {
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

function relativeModule(fromDirectory: string, target: string) {
  if (!fromDirectory) return `./${target}`;
  return `${"../".repeat(fromDirectory.split("/").length)}${target}`;
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
    export function install(value) {
      host = value;
      globalThis[callKey] = filesystemCall;
    }
    async function filesystemCall(namespace, method, args) {
      if (namespace !== "fs" || !filesystemMethods.has(method)) {
        throw new Error("The internal Workspace filesystem dispatcher only accepts node:fs operations");
      }
      return call(namespace, method, args);
    }
    export async function call(namespace, method, args) {
      if (!host) throw new Error("Workspace capabilities are not installed");
      const request = JSON.stringify(args.map(encode));
      if (new TextEncoder().encode(request).byteLength > ${maxCapabilityBytes}) {
        throw new Error(${JSON.stringify(requestTooLargeMessage)});
      }
      const raw = await host.call(namespace + "." + method, request);
      const payload = JSON.parse(String(raw));
      if (payload.error !== undefined) {
        const detail = typeof payload.error === "string" ? { message: payload.error } : payload.error;
        const error = new Error(detail.message);
        if (detail.code !== undefined) error.code = detail.code;
        if (detail.path !== undefined) error.path = detail.path;
        throw error;
      }
      return decode(payload.result);
    }
    function wrap(type, fields) {
      return { __workspace_codec__: { version: 1, type, ...fields } };
    }
    function encode(value) {
      if (value instanceof Uint8Array) return wrap("bytes", { data: Array.from(value) });
      if (Array.isArray(value)) return wrap("array", { items: value.map(encode) });
      if (value && typeof value === "object") return wrap("object", { entries: Object.entries(value).map(([key, child]) => [key, encode(child)]) });
      return value;
    }
    function decode(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      if (Object.keys(value).length !== 1 || !("__workspace_codec__" in value)) throw new Error("Invalid Workspace codec envelope");
      const codec = value.__workspace_codec__;
      if (!codec || codec.version !== 1) throw new Error("Invalid Workspace codec envelope");
      if (codec.type === "bytes") {
        if (!Array.isArray(codec.data) || !codec.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Invalid Workspace byte value");
        return new Uint8Array(codec.data);
      }
      if (codec.type === "array" && Array.isArray(codec.items)) return codec.items.map(decode);
      if (codec.type === "object" && Array.isArray(codec.entries)) return Object.fromEntries(codec.entries.map(([key, child]) => [key, decode(child)]));
      throw new Error("Invalid Workspace codec envelope");
    }
  `;
}

function proxyModule(capabilitiesImport: string, namespace: string, methods: string[]) {
  return `
    import { call } from ${JSON.stringify(capabilitiesImport)};
    ${methods.map((method) => `export const ${method} = (...args) => call(${JSON.stringify(namespace)}, ${JSON.stringify(method)}, args);`).join("\n")}
  `;
}

function trustedModule(capabilitiesImport: string, specifier: string) {
  return `
    import { call as hostCall } from ${JSON.stringify(capabilitiesImport)};
    export const call = (method, ...args) => hostCall(${JSON.stringify(`trusted/${specifier}`)}, "call", [method, ...args]);
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

function gitModule(capabilitiesImport: string) {
  return proxyModule(capabilitiesImport, "git", ["clone", "diff", "status", "log", "cli"]);
}

function artifactsModule(capabilitiesImport: string) {
  return proxyModule(capabilitiesImport, "artifacts", [
    "create",
    "get",
    "list",
    "importArtifact",
    "deleteArtifact",
  ]);
}
