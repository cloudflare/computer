export type { FUSEBackend, FuseMountMode, ResolveFuseBackendOptions } from "./backend";
export { parseFuseMountMode, resolveFuseBackend } from "./backend";
export type { FuseMount, FuseOps, FuseStat } from "./driver";
export { makeFUSEOps, mountFuse } from "./driver";
export type { MountIgnoreSet } from "./ignore";
export { MountIgnorePathError, parseMountIgnore, resolveMountIgnore } from "./ignore";
export type { MountIgnoreConfig, MountIgnoreEnv, MountIgnoreInfo } from "./ignore-config";
export {
  defaultIgnoreRoot,
  describeMountIgnore,
  PASSTHROUGH_UNAVAILABLE_REASON,
  resolveMountIgnoreConfig,
} from "./ignore-config";
export type { LocalPassthrough, LocalPassthroughOptions, PassthroughStats } from "./passthrough";
export { withLocalPassthrough } from "./passthrough";
export type { ResolvedStore, StoreMode } from "./store";
export { parseStoreMode, resolveStore } from "./store";
export type { CreateNodeVFSOptions, NodeVFSHandle, NodeVirtualFileSystem } from "./vfs";
export { createNodeVirtualFileSystem } from "./vfs";
