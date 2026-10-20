// Public surface of @cloudflare/computer/backends/dynamic-javascript.
//
// DynamicJavaScriptBackend runs ECMAScript modules like the
// worker-javascript backend, and runs Workspace files that export a
// Durable Object class as long-lived apps, each instance a facet of the
// host Durable Object.
//
// Status: experimental.

export type { WorkspaceEgressPolicy } from "../../runtime/egress.js";
export {
  DynamicJavaScriptBackend,
  type DynamicJavaScriptBackendOptions,
  type DynamicJavaScriptFacets,
  type DynamicJavaScriptLoader,
} from "./dynamic-javascript.js";
