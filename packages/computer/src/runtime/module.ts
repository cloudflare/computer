import type {
  WorkspaceHostModule,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
} from "./types.js";

/**
 * Define a host module for `WorkerJavaScriptBackend`'s `modules` option.
 *
 * Pass the functions directly when they need nothing from the
 * Workspace, or pass a factory that builds them from the Workspace's
 * Git client, Artifacts client, and runtime. The backend calls the
 * factory once when it connects.
 *
 * ```ts
 * modules: {
 *   "ws:model": defineModule({ async batch(args) { ... } }),
 *   "ws:repo": defineModule((host) => ({ async log() { return host.git.log(); } })),
 * }
 * ```
 *
 * @param functions - The module's functions, or a factory that builds them.
 * @returns A host module.
 */
export function defineModule(
  functions: WorkspaceModuleFunctions | ((host: WorkspaceModuleHost) => WorkspaceModuleFunctions),
): WorkspaceHostModule {
  return {
    kind: "host",
    create: typeof functions === "function" ? functions : () => functions,
  };
}
