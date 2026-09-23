// Public surface of @cloudflare/computer/backends/container.
//
// The container backend pairs a Workspace with a computerd daemon
// running inside a Cloudflare Container. computerd owns its own
// SQLite-backed VFS; the package syncs the two stores across a
// capnweb WebSocket.
//
// This backend serves containers the durable object schedules, which
// the wrangler containers block selects with
// `scheduling_policy: "durable_object"` and an `images` map. Under
// that policy the object owns the container lifecycle, so every
// start() has to name the image and may name an instance size; the
// block itself rejects `instance_type` and `max_instances`.
//
// A container the platform schedules is a different deployment shape
// and is served by LegacyContainerBackend from
// @cloudflare/computer/backends/container-legacy.
//
// Imported via:
//
//   import {
//     ContainerBackend,
//     withWorkspaceContainer,
//   } from "@cloudflare/computer/backends/container";

export type { WorkspaceEgressPolicy } from "../../runtime/egress.js";
export {
  ContainerBackend,
  type ContainerBackendOptions,
  type ContainerHostHolder,
} from "./container-backend.js";
export {
  type ContainerRuntimeInfo,
  type IWorkspaceContainerAPI,
  WorkspaceContainerAPI,
  type WorkspaceRef,
  withWorkspaceContainer,
} from "./container-host.js";
export type {
  ContainerInstanceSize,
  ContainerLaunchSpec,
} from "./container-launch-record.js";
