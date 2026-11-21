// Public surface of @cloudflare/computer/backends/kitebuild.
//
// Status: experimental. This entry point may change in any release
// and is not yet suitable for production use.
//
// Runs shell commands on a Kitebuild machine: busyworker's BusyBox
// userland, executed in the Workspace's own Durable Object with the
// Workspace store mounted directly. Requires the optional peer
// dependencies @cloudflare/kitebuild-runtime and
// @cloudflare/kitebuild-toolchain; further programs come from toolsets
// such as the toolchain's.
//
// Imported via:
//
//   import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";

export type { WorkspaceEgressPolicy } from "../../runtime/egress";
export {
  KitebuildBackend,
  type KitebuildBackendOptions,
  type KitebuildGitFetch,
} from "./kitebuild-backend";
export { mountWorkspace, type WorkspaceMount, type WorkspaceMountOptions } from "./workspace-mount";
