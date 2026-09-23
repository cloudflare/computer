// Public surface of @cloudflare/computer/backends/container-legacy.
//
// The container backend pairs a Workspace with a computerd daemon
// running inside a Cloudflare Container. computerd owns its own
// SQLite-backed VFS; the package syncs the two stores across a
// capnweb WebSocket.
//
// This backend serves containers the platform schedules: the
// wrangler containers block names the image and the instance type,
// and start() passes neither. A container the durable object
// schedules itself must name both at launch, which this backend has
// no way to express; use @cloudflare/computer/backends/container for
// that deployment shape.
//
// The export path it vacated now belongs to that backend rather than
// to a compatibility alias for this one. An alias would be the
// kinder choice for existing callers, but pointing the old name at a
// backend that drives a different scheduling policy is worse than an
// unresolved import: the import fails at build time and says so,
// where a silent redirect fails at runtime against a container that
// never starts.
//
// Imported via:
//
//   import {
//     LegacyContainerBackend,
//     withLegacyWorkspaceContainer,
//   } from "@cloudflare/computer/backends/container-legacy";

export type { WorkspaceEgressPolicy } from "../../runtime/egress.js";
export {
  LegacyContainerBackend,
  type LegacyContainerBackendOptions,
} from "./cloudflare-container.js";
export {
  type ContainerRuntimeInfo,
  type ILegacyWorkspaceContainerAPI,
  LegacyWorkspaceContainerAPI,
  type WorkspaceRef,
  withLegacyWorkspaceContainer,
} from "./container-host.js";
export type { ContainerLaunchSpec } from "./container-launch-record.js";
