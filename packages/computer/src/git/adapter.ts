// Bridge from `@cloudflare/dofs`'s SQLiteWorkspaceProvider to an
// FsClient that isomorphic-git can consume directly.
//
// Mirrors the recipe in `examples/think/src/tools/git/vfs.ts`
// (which mirrors the trick computerd uses for its FUSE mount):
//
//   1. SQLiteWorkspaceProvider already implements the full node:fs
//      surface @platformatic/vfs's VirtualFileSystem needs,
//      including symlink / readlink.
//   2. It does not extend @platformatic/vfs.VirtualProvider, and
//      `create()` checks `provider instanceof VirtualProvider` —
//      failing silently into an in-memory store on a miss. The
//      dofs provider therefore has to be wrapped in a
//      VirtualProvider subclass with an explicit forwarding list.
//   3. `vfs.promises` is declared as a class getter. isomorphic-git
//      probes `Object.getOwnPropertyDescriptor(fs, 'promises')`,
//      does not see an enumerable own property, and falls through
//      to its callback-style branch — which then crashes.
//      Re-exposing `promises` as an own property on a plain object
//      fixes the detection.
//
// `@platformatic/vfs` is imported lazily so the base
// `@cloudflare/computer` bundle has no static reference to it.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

/**
 * The shape isomorphic-git wants as its `fs` argument: an object
 * whose `.promises` is an own, enumerable property and implements
 * the `node:fs/promises` subset listed in `PromiseFsClient`.
 *
 * `promises` is typed as `object` rather than enumerating every
 * method @platformatic/vfs forwards. The full surface is wider
 * than this package consumes and pinning it here would either
 * leak @platformatic/vfs into our public types or force tedious
 * structural shadowing. Callers that want a typed file API can
 * cast `client.promises` to `import('@platformatic/vfs').VirtualFileSystem['promises']`.
 */
export interface IsomorphicGitFSClient {
  promises: object;
}

/**
 * Methods on `SQLiteWorkspaceProvider` forwarded through the
 * wrapping `VirtualProvider`. Listed explicitly (rather than walked
 * off the prototype) so the surface is stable across dofs releases:
 * a new method on the provider does not silently widen the wrapper.
 */
const FORWARDED_METHODS = [
  "open",
  "openSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "mkdir",
  "mkdirSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "exists",
  "existsSync",
  "copyFile",
  "copyFileSync",
  "internalModuleStat",
  "realpath",
  "realpathSync",
  "access",
  "accessSync",
  "readlink",
  "readlinkSync",
  "symlink",
  "symlinkSync",
  "watch",
  "watchAsync",
  "watchFile",
  "unwatchFile",
  // fd-style extensions @platformatic/vfs's router uses on
  // read/write paths going through `open`.
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
  "truncateSync",
  "ftruncateSync",
] as const;

/**
 * Build an isomorphic-git-compatible FsClient from a
 * SQLiteWorkspaceProvider.
 *
 * Lazily imports `@platformatic/vfs`. If the peer dep is missing,
 * the thrown error names the package so the failure mode stays
 * one stack frame away from obvious.
 */
export async function workspaceIsomorphicGitClient(
  provider: SQLiteWorkspaceProvider,
): Promise<IsomorphicGitFSClient> {
  let create: typeof import("@platformatic/vfs").create;
  let VirtualProvider: typeof import("@platformatic/vfs").VirtualProvider;
  try {
    ({ create, VirtualProvider } = await import("@platformatic/vfs"));
  } catch (cause) {
    throw new Error(
      "@cloudflare/computer/git requires @platformatic/vfs as an optional peer dependency. " +
        "Install it, or pass `fs` to clone() explicitly.",
      { cause },
    );
  }

  class SQLiteVirtualProvider extends VirtualProvider {
    readonly #inner: SQLiteWorkspaceProvider;
    constructor(inner: SQLiteWorkspaceProvider) {
      super();
      this.#inner = inner;
    }
    // VirtualProvider's defaults are false. The dofs provider
    // declares the real values as instance properties; the
    // forwarding loop below skips accessors, so re-expose them.
    override get readonly(): boolean {
      return this.#inner.readonly;
    }
    override get supportsSymlinks(): boolean {
      return this.#inner.supportsSymlinks;
    }
    override get supportsWatch(): boolean {
      return this.#inner.supportsWatch;
    }
    /** Used by the forwarding loop below. */
    get inner(): SQLiteWorkspaceProvider {
      return this.#inner;
    }
  }

  for (const name of FORWARDED_METHODS) {
    Object.defineProperty(SQLiteVirtualProvider.prototype, name, {
      value(this: SQLiteVirtualProvider, ...args: unknown[]): unknown {
        // biome-ignore lint/suspicious/noExplicitAny: dispatch table
        const inner = this.inner as any;
        const fn = inner[name];
        if (typeof fn !== "function") {
          throw new Error(`SQLiteWorkspaceProvider.${String(name)} is not a function`);
        }
        return fn.apply(inner, args);
      },
      writable: true,
      configurable: true,
    });
  }

  // `moduleHooks: false` keeps @platformatic/vfs from installing
  // Node module-resolution hooks, which depend on `node:module` and
  // are pointless inside workerd.
  const vfs = create(new SQLiteVirtualProvider(provider), { moduleHooks: false });
  // Re-expose `.promises` as an enumerable own property so
  // isomorphic-git's FileSystem detection picks the promise branch.
  return { promises: vfs.promises };
}
