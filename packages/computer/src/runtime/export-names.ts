import type { WorkspaceModuleFunctions } from "./types";

const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// `default` would turn the function into the default export, and a
// `then` export makes the module namespace look like a promise to
// `await import(...)`.
const RESERVED_EXPORT_NAMES = new Set(["default", "then"]);

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
  assertExportNames(specifier, names);
  for (const name of names) {
    if (typeof functions[name] !== "function") {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} export ${JSON.stringify(name)} must be a function.`,
      );
    }
  }
}

// Check a host module's export names.
export function assertExportNames(specifier: string, names: readonly string[]): void {
  if (names.length === 0) {
    throw new Error(`Host module ${JSON.stringify(specifier)} must export a function.`);
  }
  if (new Set(names).size !== names.length)
    throw new Error(`Host module ${JSON.stringify(specifier)} exports a name twice.`);
  for (const name of names) {
    if (typeof name !== "string" || !EXPORT_NAME.test(name) || RESERVED_EXPORT_NAMES.has(name)) {
      throw new Error(
        `Host module ${JSON.stringify(specifier)} export ${JSON.stringify(name)} must be a JavaScript identifier other than "default" or "then".`,
      );
    }
  }
}
