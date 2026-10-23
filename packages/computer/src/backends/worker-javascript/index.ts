// Public surface of @cloudflare/computer/backends/worker-javascript.
//
// WorkerJavaScriptBackend runs an ECMAScript module in a fresh Dynamic
// Worker against the Workspace's files.
//
// Status: stable.

export type { WorkspaceEgressPolicy } from "../../runtime/egress";
export { WorkerJavaScriptBackend, type WorkerJavaScriptBackendOptions } from "./worker-javascript";
