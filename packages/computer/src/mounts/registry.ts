// Mount registry.
//
// Validates roots, resolves factories to Mount instances, and exposes
// the resulting map by mount root. The registry is purely in-memory;
// _vfs_mounts persistence is the indexer's job (see index.ts).

import type { Mount, MountContext, MountFactory } from "./types.js";

export type MountValue = Mount | MountFactory;

export interface RegistryOptions {
  // Source for the MountContext.sessionId field. Defaults to "" when
  // the caller didn't supply one.
  sessionId?: string;
  // Builder for the VFS handle handed to factories. Lazy so we don't
  // construct a SQLiteWorkspaceProvider for callers with no factory
  // mounts.
  vfs: () => MountContext["vfs"];
}

function validateRoot(root: string): void {
  if (root.length === 0 || !root.startsWith("/")) {
    throw new Error(`mount root must be absolute (starts with '/'): ${JSON.stringify(root)}`);
  }
  if (root.length > 1 && root.endsWith("/")) {
    throw new Error(`mount root must not have a trailing slash: ${JSON.stringify(root)}`);
  }
}

function rejectNesting(roots: string[]): void {
  // O(n^2) is fine; we expect a handful of mounts per workspace.
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      if (i === j) continue;
      const a = roots[i];
      const b = roots[j];
      // a is an ancestor of b when b starts with `${a}/`. Compare
      // with the trailing slash so /workspace/a is not flagged as
      // an ancestor of /workspace/another.
      if (b.startsWith(`${a}/`)) {
        throw new Error(`mount roots must not nest: ${a} contains ${b}`);
      }
    }
  }
}

export function buildMountRegistry(
  mounts: Record<string, MountValue> | undefined,
  options: RegistryOptions,
): Map<string, Mount> {
  const out = new Map<string, Mount>();
  if (mounts === undefined) return out;
  const roots = Object.keys(mounts);
  for (const root of roots) validateRoot(root);
  rejectNesting(roots);

  const sessionId = options.sessionId ?? "";
  // Build the VFS handle only once even when multiple factories ask
  // for it.
  let vfsCached: MountContext["vfs"] | undefined;
  const vfs = (): MountContext["vfs"] => {
    if (vfsCached === undefined) vfsCached = options.vfs();
    return vfsCached;
  };

  for (const root of roots) {
    const value = mounts[root];
    if (typeof value === "function") {
      const ctx: MountContext = { sessionId, root, vfs: vfs() };
      out.set(root, value(ctx));
    } else {
      out.set(root, value);
    }
  }
  return out;
}
