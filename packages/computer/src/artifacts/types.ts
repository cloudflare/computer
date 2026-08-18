// Wrapper-owned types for the artifacts surface.
//
// The Cloudflare Artifacts Workers binding ships its own types in
// `@cloudflare/workers-types`: the global `Artifacts` binding,
// `ArtifactsRepo` handle, `ArtifactsCreateRepoResult`,
// `ArtifactsRepoInfo`, `ArtifactsTokenInfo`, `ArtifactsError`, and
// friends. This module does not redeclare them — it consumes the
// globals directly, the same way the rest of the package consumes
// `ReadableStream` and other Workers globals. Consumers get the
// types transitively through `@cloudflare/workers-types`.
//
// What lives here is the small set of types the wrapper itself owns
// and that have no global equivalent.

/**
 * Token scope. `write` grants push; `read` is fetch-only. Mirrors
 * the binding's `"read" | "write"` literal; named here so the
 * wrapper and CLI can refer to it by a single alias.
 */
export type ArtifactScope = "read" | "write";
