// Hand-written env shape for the platform Worker. Run
// `wrangler types` to regenerate from wrangler.jsonc when the
// bindings change.
//
// Kept to the bindings themselves rather than checking in the
// generated file, which also inlines the whole workerd type library.
// The runtime types come from the @cloudflare/workers-types
// devDependency, named in tsconfig.json alongside this file.

interface Env {
  AgentExample: DurableObjectNamespace<import("./src/index.js").AgentExample>;
  LOADER: WorkerLoader;
  AI: Ai;
}
