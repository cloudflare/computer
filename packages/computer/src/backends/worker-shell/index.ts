// Public surface of @cloudflare/computer/backends/worker.
//
// The worker backend pairs a Workspace with a just-bash shell
// running in a Dynamic Worker minted through env.LOADER. Every
// filesystem operation from inside the shell forwards back to
// the host Durable Object through a WorkspaceServiceProxy
// loopback; the DO's SQLite is the single authoritative store.
//
// Imported via:
//
//   import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
//
// The package ships the shell as feature groups: SHELL_CORE_MODULES
// (the always-on core — the pre-built ShellWorker entry plus every
// dynamic chunk just-bash code-splits into for the base command
// set) and one optional group per command at
// @cloudflare/computer/shell/<feature>. A consumer imports the
// optional groups it wants and passes them to WorkerShellBackend's
// `commands` option; groups it never imports drop out of its
// bundle. It also ships SHELL_RUNTIME_MODULES — the module shims
// just-bash's static native imports need to load under workerd.
// The backend assembles core + `commands` and spreads the runtime
// shims into the Loader callback's `modules` table internally.
// assembleShellModules is exposed for consumers that construct the
// Loader callback by hand (in which case they pass a `fetcher`
// factory to WorkerShellBackend instead of `loader` + `workspace` +
// `ctx`).

export type { WorkspaceEgressPolicy } from "../../runtime/egress.js";
export { type WorkspaceFs, WorkspaceFsAdapter } from "./adapter.js";
export { type ArtifactsCommandHost, defineArtifactsCommand } from "./artifacts-command.js";
export { type AssetsCommandHost, defineAssetsCommand } from "./assets-command.js";
export { type ExecInput, ShellWorker, type ShellWorkerOptions } from "./entrypoint.js";
export { defineGitCommand, type GitCommandHost } from "./git-command.js";
export { SHELL_RUNTIME_MODULES } from "./runtime-modules.js";
export {
  assembleShellModules,
  SHELL_CORE_MODULES,
  type ShellModuleGroup,
} from "./shell-modules.js";
export {
  WorkerShellBackend,
  type WorkerShellBackendOptions,
  type WorkerShellLoader,
  type WorkerShellRuntime,
  type WorkerShellSource,
} from "./worker-shell.js";
