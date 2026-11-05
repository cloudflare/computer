// Public surface of @cloudflare/computer/backends/codemode.
//
// CodemodeBackend runs an ECMAScript module in a fresh Dynamic
// Worker against the Workspace's files.
//
// Status: stable.

export type { WorkspaceEgressPolicy } from "../../runtime/egress";
export { CodemodeBackend, type CodemodeBackendOptions } from "./codemode";
