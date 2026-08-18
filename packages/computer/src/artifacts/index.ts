// Public surface of @cloudflare/computer/artifacts.
//
// `createArtifact(binding, sessionId)` is the one entry point. It
// binds a Cloudflare Artifacts namespace binding and a session id
// and returns a client whose every operation is scoped under that
// session — repository names are prefixed on the way in and
// stripped on the way out, so callers work entirely in local names.
//
// The session id is optional. Without one the client spans the
// namespace: names are the ones the binding stores, and every
// repository is listed and reachable, including those sessions own.
//
// The typed client and the argv-driven CLI (`client.cli(...)`)
// share one implementation. The worker backend's `artifacts` custom
// command dispatches through the CLI so the in-shell tool and the
// JS API cannot drift.
//
//   import { createArtifact } from "@cloudflare/computer/artifacts";
//
// The binding, its repo handle, and the result shapes (`Artifacts`,
// `ArtifactsRepo`, `ArtifactsCreateRepoResult`, ...) are the global
// types from `@cloudflare/workers-types`; this module re-exports
// only what it owns.

export type { ArtifactsCLIInput, ArtifactsCLIResult, RemoteAddFn } from "./cli.js";
export { runArtifactsCLI } from "./cli.js";
export type {
  ArtifactClient,
  ArtifactImportOptions,
  ArtifactImportSource,
  ArtifactRepoSummary,
} from "./client.js";
export { createArtifact } from "./client.js";
export {
  ArtifactError,
  InvalidRepoNameError,
  InvalidSessionIdError,
  NotFoundError,
} from "./errors.js";
export type { ArtifactScope } from "./types.js";
