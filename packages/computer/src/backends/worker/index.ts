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
//   import { WorkerBackend } from "@cloudflare/computer/backends/worker";
//
// The package ships SHELL_MODULES — a record of module name →
// source string covering the pre-built ShellWorker entry plus
// every dynamic chunk just-bash code-splits into — and
// SHELL_RUNTIME_MODULES — the module shims just-bash's static
// native imports need to load under workerd. The backend
// spreads both into the Loader callback's `modules` table
// internally; consumers only need to reach for them when they
// construct the Loader callback by hand (in which case they
// pass a `fetcher` factory to WorkerBackend instead of
// `loader` + `workspace` + `ctx`).

export { type WorkspaceFs, WorkspaceFsAdapter } from "./adapter.js";
export { type ArtifactsCommandHost, defineArtifactsCommand } from "./artifacts-command.js";
export { type AssetsCommandHost, defineAssetsCommand } from "./assets-command.js";
export { type ExecInput, ShellWorker, type ShellWorkerOptions } from "./entrypoint.js";
export { SHELL_MODULES } from "./generated-bundle.js";
export { defineGitCommand, type GitCommandHost } from "./git-command.js";
export { SHELL_RUNTIME_MODULES } from "./runtime-modules.js";
export { WorkerBackend, type WorkerBackendOptions, type WorkerShellFetcher } from "./worker.js";
