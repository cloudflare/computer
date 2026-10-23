export type { FUSEBackend, FuseMountMode, ResolveFuseBackendOptions } from "./backend.js";
export { parseFuseMountMode, resolveFuseBackend } from "./backend.js";
export type { FuseMount, FuseOps, FuseStat, RemovalGuardBinding } from "./driver.js";
export { makeFUSEOps, mountFuse } from "./driver.js";
export { nativeRootsRequested, passthroughRequested } from "./options.js";
export type { MountIgnoreSet } from "./ignore.js";
export { MountIgnorePathError, parseMountIgnore, resolveMountIgnore } from "./ignore.js";
export type {
  MountIgnoreConfig,
  MountIgnoreEnv,
  MountIgnoreInfo,
  NativeRootsInfo,
  NativeRootsStatus,
  PassthroughStatus,
} from "./ignore-config.js";
export {
  defaultIgnoreRoot,
  describeMountIgnore,
  resolveMountIgnoreConfig,
} from "./ignore-config.js";
export type {
  NativeRoots,
  NativeRootsOptions,
  NativeRootsStats,
  RemovalGuard,
} from "./native-roots.js";
export { createNativeRoots } from "./native-roots.js";
export type { LocalPassthrough, LocalPassthroughOptions, PassthroughStats } from "./passthrough.js";
export { withLocalPassthrough } from "./passthrough.js";
export type { ResolvedStore, StoreMode } from "./store.js";
export { parseStoreMode, resolveStore } from "./store.js";
export type { CreateNodeVFSOptions, NodeVFSHandle, NodeVirtualFileSystem } from "./vfs.js";
export { createNodeVirtualFileSystem } from "./vfs.js";
