export type { FUSEBackend, FuseMountMode, ResolveFuseBackendOptions } from "./backend.js";
export { parseFuseMountMode, resolveFuseBackend } from "./backend.js";
export type { FuseMount, FuseOps, FuseStat } from "./driver.js";
export { makeFUSEOps, mountFuse } from "./driver.js";
export type { MountIgnoreSet } from "./ignore.js";
export { MountIgnorePathError, parseMountIgnore, resolveMountIgnore } from "./ignore.js";
export type { MountIgnoreConfig, MountIgnoreEnv, MountIgnoreInfo } from "./ignore-config.js";
export {
  defaultIgnoreRoot,
  describeMountIgnore,
  PASSTHROUGH_UNAVAILABLE_REASON,
  resolveMountIgnoreConfig,
} from "./ignore-config.js";
export type { LocalPassthrough, LocalPassthroughOptions, PassthroughStats } from "./passthrough.js";
export { withLocalPassthrough } from "./passthrough.js";
export type { ResolvedStore, StoreMode } from "./store.js";
export { parseStoreMode, resolveStore } from "./store.js";
export type { CreateNodeVFSOptions, NodeVFSHandle, NodeVirtualFileSystem } from "./vfs.js";
export { createNodeVirtualFileSystem } from "./vfs.js";
