// Assembles the Worker Loader modules table the shell runs from.
//
// build-bundle.mjs runs esbuild with splitting: true and
// partitions the emitted modules into a core group (every
// always-on command plus the ShellWorker entry) and one group per
// optional command, each published on its own
// @cloudflare/computer/shell/<feature> subpath.
//
// Selection is import-based, not flag-based: this module imports
// only the core group. A consumer opts a command in by importing
// its group module and passing it to WorkerBackend's `commands`
// option (or into assembleShellModules directly). Because nothing
// here references the optional groups, a group the consumer never
// imports is unreachable in their module graph and the bundler
// drops it — no build-time define, no explicit opt-out needed.

import coreModules from "@cloudflare/computer/shell/core";

// One generated feature group: module name -> source string. The
// core group and every @cloudflare/computer/shell/<feature> import
// share this shape.
export type ShellModuleGroup = Readonly<Record<string, { js: string }>>;

// The always-on core group. Ships in every Worker shell; carries
// the ShellWorker entry (shell.js), the base command set, and the
// secure-fetch seam curl runs on when its group is included.
export const SHELL_CORE_MODULES: ShellModuleGroup = Object.freeze({ ...coreModules });

// Merge the core group with the optional groups the consumer
// imported and passed. Later groups win on key collisions, but the
// build keeps groups disjoint so order never matters in practice.
export function assembleShellModules(
  groups: readonly ShellModuleGroup[] = [],
): Readonly<Record<string, { js: string }>> {
  const modules: Record<string, { js: string }> = { ...coreModules };
  for (const group of groups) {
    Object.assign(modules, group);
  }
  return Object.freeze(modules);
}
