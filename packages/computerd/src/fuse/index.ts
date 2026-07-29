export type { FUSEBackend, FuseMountMode, ResolveFuseBackendOptions } from "./backend.js";
export { parseFuseMountMode, resolveFuseBackend } from "./backend.js";
export type { FuseMount, FuseOps, FuseStat } from "./driver.js";
export { makeFUSEOps, mountFuse } from "./driver.js";
export type { NodeVirtualFileSystem } from "./vfs.js";
export { createNodeVirtualFileSystem } from "./vfs.js";
