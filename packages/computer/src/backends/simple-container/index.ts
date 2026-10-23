// Public surface of @cloudflare/computer/backends/simple-container.
//
// A container backend with no filesystem sync. The container keeps its
// own disk; code copies files in and out explicitly, usually through
// `ws:container`'s push and pull:
//
//   import { SimpleContainerBackend } from "@cloudflare/computer/backends/simple-container";
//   import { createContainerModule } from "@cloudflare/computer/modules/container";
//
//   const container = new SimpleContainerBackend({
//     container: () => this,
//     workspace: { binding: "Agent", id: this.ctx.id.toString() },
//   });
//   new WorkerJavaScriptBackend({
//     loader: env.LOADER,
//     modules: { "ws:container": createContainerModule({ backend: container }) },
//   });
//
// The container host side is the same as ContainerBackend's: mix
// withWorkspaceContainer into the Durable Object class from
// @cloudflare/computer/backends/container.
//
// Status: experimental. This entry point may change in any release
// and is not yet suitable for production use.

export { type FileConflict, FileTransferConflictError } from "@cloudflare/computer-rpc/files";
export type {
  PullResult,
  PushResult,
  TransferFilesystem,
  TransferOptions,
} from "./file-transfer.js";
export {
  SimpleContainerBackend,
  type SimpleContainerBackendOptions,
} from "./simple-container-backend.js";
