// Public surface of @cloudflare/computer/backends/container.
//
// The container backend pairs a Workspace with a computerd daemon
// running inside a Cloudflare Container. computerd owns its own
// SQLite-backed VFS; the package syncs the two stores across a
// capnweb WebSocket.
//
// Imported via:
//
//   import {
//     CloudflareContainerBackend,
//     withWorkspaceContainer,
//   } from "@cloudflare/computer/backends/container";

export type { WorkspaceEgressPolicy } from "../../runtime/egress.js";
export {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
} from "./cloudflare-container.js";
export {
  type IWorkspaceContainerAPI,
  WorkspaceContainerAPI,
  type WorkspaceRef,
  withWorkspaceContainer,
} from "./container-host.js";
