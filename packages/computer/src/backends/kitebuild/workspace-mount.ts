// Mounts part of the Workspace store into a Kitebuild machine's VFS.
//
// The machine runs in the Durable Object that owns the Workspace, and
// both sides use the same synchronous Durable Object SQLite, so the
// mount reads and writes the Workspace's own rows through
// SQLiteWorkspaceProvider. There is one copy of every file and no sync
// protocol: the agent's file tools and the shell see the same store.
//
// The VFS keeps its own tree of nodes. Directories load on first look
// through readdirStatsSync, one statement per directory. File bodies
// read through a bounded cache and write through dofs write buffers:
// a new file is a pending-create buffer, so its row, bytes and mode
// land in one transaction, and at most `writeBuffers` files are held
// open at once. flush() releases them, as at the end of a command.
//
// Two known differences from Linux remain, because dofs addresses file
// bytes by path. A file renamed over or unlinked while a process holds
// it open can no longer be read through that descriptor, and a write
// to it fails. Both are rare in build and test tools.

import type { SQLiteWorkspaceProvider, WorkspaceDirentStats } from "@cloudflare/dofs";
import {
  type FileBody,
  type FsNode,
  LazyChildren,
  nextGeneration,
  Vfs,
  type VfsPersistence,
} from "@cloudflare/kitebuild-runtime/vfs";

export interface WorkspaceMountOptions {
  /** Most file bodies kept in memory for reads, in bytes. */
  cacheBytes?: number;
  /** Most files with an open dofs write buffer at once. */
  writeBuffers?: number;
}

export interface WorkspaceMount {
  /** Release every open write buffer, committing it to the store. */
  flush(): void;
  /**
   * Bring the loaded tree up to date with Workspace paths that changed
   * outside the machine. Nodes keep their identity, so descriptors a
   * running process holds stay usable; directories not yet loaded are
   * left alone, since they load fresh.
   */
  refresh(changed: Iterable<string>): void;
}

type Provider = Pick<
  SQLiteWorkspaceProvider,
  | "lstatSync"
  | "readlinkSync"
  | "readdirStatsSync"
  | "mkdirSync"
  | "rmdirSync"
  | "unlinkSync"
  | "linkSync"
  | "renameSync"
  | "symlinkSync"
  | "chmodSync"
  | "utimesSync"
  | "writeFileSync"
  | "writeRangeSync"
  | "truncateFileSync"
  | "readRangeSync"
  | "openWriteBufferSync"
  | "openWriteBufferForCreateSync"
  | "releaseWriteBufferSync"
>;

// Linux errno values the VFS expects back from a persistence hook.
const ERRNO: Record<string, number> = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EROFS: 30,
  ENOSYS: 38,
  ENOTEMPTY: 39,
};

function errnoOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  return -(typeof code === "string" && code in ERRNO ? ERRNO[code] : ERRNO.EIO);
}

const TYPE_BITS = { dir: 0o040000, symlink: 0o120000, reg: 0o100000 } as const;
// Inode numbers the VFS reports: dofs inodes offset into their own
// range, and files that exist only as pending buffers above that.
const INODE_BASE = 700_000;
const PENDING_INODE_BASE = 900_000_000;

// A Buffer view of the same bytes, as the provider's signature asks.
const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

export function mountWorkspace(
  vfs: Vfs,
  path: string,
  provider: Provider,
  { cacheBytes = 8 * 1024 * 1024, writeBuffers = 16 }: WorkspaceMountOptions = {},
): WorkspaceMount {
  /**
   * Workspace paths of every node the mount has handed out. A hard-linked
   * file has one node and a path per name; I/O goes through the first, so
   * it keeps working while any name remains.
   */
  const paths = new Map<FsNode, string[]>();
  /** One node per dofs inode, so hard links share a node. */
  const byInode = new Map<number, FsNode>();
  /** Files with an open write buffer, oldest first. */
  const buffered = new Map<FsNode, Body>();
  /** Files created as pending buffers and not yet committed. */
  const pending = new Set<FsNode>();
  /** Cached file bytes, least recently used first. */
  const cache = new Map<FsNode, Uint8Array>();
  let cachedBytes = 0;
  let pendingInode = PENDING_INODE_BASE;

  const pathOf = (node: FsNode): string => {
    const found = paths.get(node)?.[0];
    if (found === undefined) throw Object.assign(new Error("node is not mounted"), { code: "EIO" });
    return found;
  };

  const addPath = (node: FsNode, nodePath: string): void => {
    const known = paths.get(node);
    if (known === undefined) paths.set(node, [nodePath]);
    else if (!known.includes(nodePath)) known.push(nodePath);
  };

  // Drop one of a node's names. Returns whether it has none left.
  const removePath = (node: FsNode, nodePath: string): boolean => {
    const left = (paths.get(node) ?? []).filter((known) => known !== nodePath);
    if (left.length === 0) paths.delete(node);
    else paths.set(node, left);
    return left.length === 0;
  };

  // Move a node's name `from` to `to`, and under a directory every name
  // below it.
  const movePaths = (node: FsNode, from: string, to: string): void => {
    for (const [other, known] of paths) {
      const moved = known.map((otherPath) =>
        other === node && otherPath === from
          ? to
          : node.type === "dir" && otherPath.startsWith(`${from}/`)
            ? to + otherPath.slice(from.length)
            : otherPath,
      );
      paths.set(other, [...new Set(moved)]);
    }
  };

  /**
   * Nodes whose last name a refresh found gone, with that name. A node kept
   * this way is reused when its inode turns up at another path: the
   * Workspace renamed it.
   */
  const vanished = new Map<FsNode, string>();

  const uncache = (node: FsNode): void => {
    const bytes = cache.get(node);
    if (bytes === undefined) return;
    cache.delete(node);
    cachedBytes -= bytes.byteLength;
  };

  const release = (node: FsNode): void => {
    if (!buffered.delete(node)) return;
    const created = pending.delete(node);
    provider.releaseWriteBufferSync(pathOf(node));
    // A new file has an inode only now; learn it, so a link the Workspace
    // adds later reaches this node.
    if (created) {
      const { ino } = provider.lstatSync(pathOf(node));
      node.ino = INODE_BASE + ino;
      byInode.set(ino, node);
    }
  };

  const releaseAll = (): void => {
    for (const node of [...buffered.keys()]) release(node);
  };

  const buffer = (node: FsNode, body: Body): void => {
    if (buffered.has(node)) {
      buffered.delete(node);
      buffered.set(node, body);
      return;
    }
    provider.openWriteBufferSync(pathOf(node));
    buffered.set(node, body);
    evictBuffer();
  };

  const evictBuffer = (): void => {
    if (buffered.size <= writeBuffers) return;
    const [oldest] = buffered.keys();
    if (oldest !== undefined) release(oldest);
  };

  class Body implements FileBody {
    readonly residentBytes = 0;
    // Changes with every write, here or (through refresh) outside the machine.
    generation = nextGeneration();
    #listeners?: Set<() => void>;

    constructor(
      private readonly node: FsNode,
      public size: number,
    ) {}

    readInto(target: Uint8Array, offset: number): number {
      const count = Math.min(target.byteLength, Math.max(0, this.size - offset));
      if (count === 0) return 0;
      const whole = this.#cached();
      if (whole !== undefined) {
        target.set(whole.subarray(offset, offset + count));
        return count;
      }
      const bytes = provider.readRangeSync(pathOf(this.node), offset, count);
      target.set(bytes);
      return bytes.byteLength;
    }

    writeFrom(source: Uint8Array, offset: number): void {
      if (source.byteLength === 0) return;
      uncache(this.node);
      buffer(this.node, this);
      provider.writeRangeSync(pathOf(this.node), source, offset);
      this.size = Math.max(this.size, offset + source.byteLength);
      this.#notify();
    }

    truncate(size: number): void {
      if (size === this.size) return;
      uncache(this.node);
      provider.truncateFileSync(pathOf(this.node), size);
      this.size = size;
      this.#notify();
    }

    replace(source: Uint8Array): void {
      // Creating a file through open(O_CREAT) replaces it with nothing.
      if (source.byteLength === 0 && this.size === 0) return;
      uncache(this.node);
      release(this.node);
      provider.writeFileSync(pathOf(this.node), asBuffer(source));
      this.size = source.byteLength;
      this.#notify();
    }

    snapshot(): Uint8Array<ArrayBuffer> {
      const out = new Uint8Array(this.size);
      this.readInto(out, 0);
      return out;
    }

    observeMutations(listener: () => void): () => void {
      const listeners = (this.#listeners ??= new Set());
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    // The whole file, from the cache or read into it when it fits.
    #cached(): Uint8Array | undefined {
      const hit = cache.get(this.node);
      if (hit !== undefined && hit.byteLength === this.size) {
        cache.delete(this.node);
        cache.set(this.node, hit);
        return hit;
      }
      if (buffered.has(this.node) || this.size > cacheBytes / 8) return undefined;
      uncache(this.node);
      const bytes = provider.readRangeSync(pathOf(this.node), 0, this.size);
      if (bytes.byteLength !== this.size) return undefined;
      cache.set(this.node, bytes);
      cachedBytes += bytes.byteLength;
      for (const [node, old] of cache) {
        if (cachedBytes <= cacheBytes) break;
        cache.delete(node);
        cachedBytes -= old.byteLength;
      }
      return bytes;
    }

    #notify(): void {
      this.generation = nextGeneration();
      if (this.#listeners) for (const listener of this.#listeners) listener();
    }
  }

  // Bring a loaded node up to date with what the Workspace stores for it,
  // dropping cached bytes of a file it changed.
  const update = (
    node: FsNode,
    stat: { mode: number; mtime: number; nlink: number; size: number; linkTarget?: string },
  ): void => {
    node.mode = TYPE_BITS[node.type as keyof typeof TYPE_BITS] | (stat.mode & 0o7777);
    node.mtime = Math.floor(stat.mtime / 1000);
    node.nlink = stat.nlink;
    if (node.body instanceof Body && !buffered.has(node)) {
      uncache(node);
      node.body.size = stat.size;
      node.body.generation = nextGeneration();
    }
    if (node.type === "symlink" && stat.linkTarget !== undefined) node.link = stat.linkTarget;
  };

  const makeNode = (
    nodePath: string,
    entry: Pick<WorkspaceDirentStats, "inode" | "type" | "mode" | "mtime" | "nlink" | "size"> & {
      linkTarget?: string;
    },
  ): FsNode => {
    const existing = entry.inode > 0 ? byInode.get(entry.inode) : undefined;
    if (existing !== undefined) {
      const old = vanished.get(existing);
      if (old === undefined) {
        addPath(existing, nodePath);
      } else {
        vanished.delete(existing);
        movePaths(existing, old, nodePath);
      }
      update(existing, entry);
      return existing;
    }
    const type = entry.type === "file" ? "reg" : entry.type;
    const node: FsNode = {
      type,
      mode: TYPE_BITS[type] | (entry.mode & 0o7777),
      uid: 0,
      gid: 0,
      mtime: Math.floor(entry.mtime / 1000),
      ino: INODE_BASE + entry.inode,
      nlink: entry.nlink,
      persistence,
    };
    paths.set(node, [nodePath]);
    if (entry.inode > 0) byInode.set(entry.inode, node);
    if (type === "dir") node.children = new LazyChildren(() => loadChildren(node));
    else if (type === "reg") node.body = new Body(node, entry.size);
    else node.link = entry.linkTarget ?? "";
    return node;
  };

  // A node for a path, from lstat. Used for the mount root and for
  // directories and symlinks the mount itself creates.
  const nodeAt = (nodePath: string): FsNode => {
    const stat = provider.lstatSync(nodePath);
    return makeNode(nodePath, {
      inode: stat.ino,
      type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat.mode,
      mtime: stat.mtimeMs,
      nlink: stat.nlink,
      size: stat.size,
      linkTarget: stat.isSymbolicLink() ? provider.readlinkSync(nodePath) : undefined,
    });
  };

  /** Directories whose children have been read, so refresh must update them. */
  const loaded = new WeakSet<FsNode>();

  const loadChildren = (dir: FsNode): Array<readonly [string, FsNode]> => {
    const dirPath = pathOf(dir);
    loaded.add(dir);
    return provider
      .readdirStatsSync(dirPath)
      .map((entry) => [entry.name, makeNode(join(dirPath, entry.name), entry)] as const);
  };

  const forget = (node: FsNode): void => {
    uncache(node);
    paths.delete(node);
    vanished.delete(node);
    byInode.delete(node.ino - INODE_BASE);
  };

  const persistence: VfsPersistence = {
    create(parent, name, type, mode, link, contents) {
      try {
        const nodePath = join(pathOf(parent), name);
        if (type === "reg" && !contents?.byteLength) {
          const node: FsNode = {
            type: "reg",
            mode: TYPE_BITS.reg | (mode & 0o7777),
            uid: 0,
            gid: 0,
            mtime: Math.floor(Date.now() / 1000),
            ino: pendingInode++,
            nlink: 1,
            persistence,
          };
          const body = new Body(node, 0);
          node.body = body;
          paths.set(node, [nodePath]);
          provider.openWriteBufferForCreateSync(nodePath, { mode: mode & 0o7777 });
          buffered.set(node, body);
          pending.add(node);
          evictBuffer();
          return node;
        }
        if (type === "dir") provider.mkdirSync(nodePath, { mode });
        else if (type === "symlink") provider.symlinkSync(link ?? "", nodePath);
        else provider.writeFileSync(nodePath, asBuffer(contents ?? new Uint8Array(0)), { mode });
        const node = nodeAt(nodePath);
        if (node.children instanceof LazyChildren) {
          node.children = new Map();
          loaded.add(node);
        }
        return node;
      } catch (error) {
        return errnoOf(error);
      }
    },
    remove(parent, name, node) {
      try {
        releaseAll();
        const nodePath = join(pathOf(parent), name);
        if (node.type === "dir") provider.rmdirSync(nodePath);
        else provider.unlinkSync(nodePath);
        // A hard-linked file stays reachable, by the same node, through its other names.
        if (removePath(node, nodePath) || node.type === "dir") forget(node);
        return 0;
      } catch (error) {
        return errnoOf(error);
      }
    },
    rename(oldParent, oldName, node, newParent, newName, replaced) {
      try {
        releaseAll();
        const from = join(pathOf(oldParent), oldName);
        const to = join(pathOf(newParent), newName);
        provider.renameSync(from, to);
        if (replaced !== undefined && removePath(replaced, to)) forget(replaced);
        movePaths(node, from, to);
        return 0;
      } catch (error) {
        return errnoOf(error);
      }
    },
    link(node, newParent, newName) {
      try {
        releaseAll();
        const nodePath = join(pathOf(newParent), newName);
        provider.linkSync(pathOf(node), nodePath);
        addPath(node, nodePath);
        return 0;
      } catch (error) {
        return errnoOf(error);
      }
    },
    update(node, { mode, mtime }) {
      try {
        if (mode !== undefined) provider.chmodSync(pathOf(node), mode & 0o7777);
        if (mtime !== undefined) provider.utimesSync(pathOf(node), mtime, mtime);
        return 0;
      } catch (error) {
        return errnoOf(error);
      }
    },
    flush() {
      try {
        releaseAll();
        return 0;
      } catch (error) {
        return errnoOf(error);
      }
    },
  };

  const normalized = Vfs.normalize(path);
  if (normalized === null || normalized === "/") {
    throw new Error(`KitebuildBackend: cannot mount the Workspace at ${path}`);
  }
  const slash = normalized.lastIndexOf("/");
  const parentPath = slash === 0 ? "/" : normalized.slice(0, slash);
  const name = normalized.slice(slash + 1);
  vfs.mkdirp(parentPath);
  const siblings = vfs.stat(parentPath)?.children;
  if (siblings === undefined) throw new Error(`KitebuildBackend: no directory ${parentPath}`);

  const root = nodeAt(normalized);
  siblings.set(name, root);

  // The loaded directory holding `changed`, or undefined when the path
  // is outside the mount or under a directory not yet loaded.
  const loadedParent = (changed: string): FsNode | undefined => {
    if (!changed.startsWith(`${normalized}/`)) return undefined;
    const parts = changed.slice(normalized.length + 1).split("/");
    let dir: FsNode | undefined = root;
    for (const part of parts.slice(0, -1)) {
      if (dir === undefined || !loaded.has(dir)) return undefined;
      dir = dir.children?.get(part);
    }
    return dir !== undefined && loaded.has(dir) ? dir : undefined;
  };

  const refreshOne = (changed: string): void => {
    const dir = loadedParent(changed);
    if (dir?.children === undefined) return;
    const entry = changed.slice(changed.lastIndexOf("/") + 1);
    const current = dir.children.get(entry);
    let stat: ReturnType<Provider["lstatSync"]> | undefined;
    try {
      stat = provider.lstatSync(changed);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    // A node losing this name moves to one of its others for I/O, names
    // below a directory included. With no other name it keeps this one, so
    // a descriptor a process holds stays usable, until its inode turns up at
    // another path.
    const releaseName = (node: FsNode): void => {
      uncache(node);
      const other = paths.get(node)?.find((known) => known !== changed);
      if (other !== undefined) movePaths(node, changed, other);
      else vanished.set(node, changed);
    };
    if (stat === undefined) {
      if (current !== undefined) {
        releaseName(current);
        dir.children.delete(entry);
      }
      return;
    }
    const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "reg";
    // The node already loaded for this path, or one the mount created
    // itself and has not learnt the inode of.
    if (
      current?.type === type &&
      (current.ino === INODE_BASE + stat.ino || current.ino >= PENDING_INODE_BASE)
    ) {
      update(current, {
        mode: stat.mode,
        mtime: stat.mtimeMs,
        nlink: stat.nlink,
        size: stat.size,
        linkTarget: type === "symlink" ? provider.readlinkSync(changed) : undefined,
      });
      return;
    }
    if (current !== undefined) releaseName(current);
    dir.children.set(entry, nodeAt(changed));
  };

  return {
    flush: releaseAll,
    refresh(changed) {
      // Parents first, so a new directory is in place before its entries.
      const ordered = [...new Set(changed)].sort(
        (a, b) => a.split("/").length - b.split("/").length,
      );
      for (const one of ordered) refreshOne(one);
    },
  };
}
