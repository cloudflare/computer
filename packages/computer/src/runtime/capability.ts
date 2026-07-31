import type {
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeFilesystem,
  WorkspaceRuntimeValue,
} from "./types.js";

export class WorkspaceRuntimeCapability {
  readonly #fs: WorkspaceRuntimeFilesystem;
  readonly #root: string;
  readonly #access: WorkspaceRuntimeAccess;
  readonly #maxReadBytes: number;
  readonly #maxDirectoryEntries: number;

  constructor(
    fs: WorkspaceRuntimeFilesystem,
    root: string,
    access: WorkspaceRuntimeAccess,
    maxReadBytes = 1024 * 1024,
    maxDirectoryEntries = 1024,
  ) {
    this.#fs = fs;
    this.#root = normalizeRoot(root);
    this.#access = access;
    this.#maxReadBytes = maxReadBytes;
    this.#maxDirectoryEntries = maxDirectoryEntries;
  }

  get access(): WorkspaceRuntimeAccess {
    return this.#access;
  }

  async readFile(path: string) {
    const resolved = await this.#resolveSafe(path);
    await this.#assertReadableSize(resolved);
    return this.#fs.readFile(resolved, "utf8");
  }

  async readFileBytes(path: string) {
    const resolved = await this.#resolveSafe(path);
    await this.#assertReadableSize(resolved);
    const stream = await this.#fs.readFile(resolved);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxReadBytes) {
          await reader.cancel("Workspace runtime file read limit exceeded");
          throw new Error(`Workspace runtime file read exceeds ${this.#maxReadBytes} bytes.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async stat(path: string) {
    return this.#fs.stat(await this.#resolveSafe(path));
  }

  async lstat(path: string) {
    const resolved = this.resolve(path);
    await this.#assertSafeComponents(resolved, false, true);
    return this.#fs.lstat(resolved);
  }

  async exists(path: string) {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async readlink(path: string) {
    const resolved = this.resolve(path);
    await this.#assertSafeComponents(resolved, false, true);
    return this.#fs.readlink(resolved);
  }

  async readdir(path = ".") {
    return (await this.#readdirEntries(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path = ".") {
    return (await this.#readdirEntries(path)).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
    }));
  }

  async #readdirEntries(path: string) {
    const entries = await this.#fs.readdir(await this.#resolveSafe(path), {
      limit: this.#maxDirectoryEntries + 1,
    });
    if (entries.length > this.#maxDirectoryEntries) {
      throw new Error(`Workspace runtime directory exceeds ${this.#maxDirectoryEntries} entries.`);
    }
    return entries;
  }

  async find(directory = ".", pattern?: string) {
    return this.#fs.find(await this.#resolveSafe(directory), pattern);
  }

  async glob(pattern: string) {
    await this.#assertSafeComponents(this.#root, false);
    return this.#fs.find(this.#root, pattern);
  }

  async ls(prefix = ".") {
    return this.#fs.ls(await this.#resolveSafe(prefix, true));
  }

  async grep(pattern: string, path = ".", options?: { ignoreCase?: boolean }) {
    return this.#fs.grep(pattern, await this.#resolveSafe(path), options);
  }

  async writeFile(path: string, content: string | Uint8Array) {
    this.#requireWrite();
    const resolved = await this.#resolveSafe(path, true);
    const parent = resolved.slice(0, resolved.lastIndexOf("/")) || this.#root;
    await this.#fs.mkdir(parent, { recursive: true });
    await this.#assertSafeComponents(parent, false);
    await this.#fs.writeFile(resolved, content);
  }

  async writeFileNode(path: string, content: string | Uint8Array, options?: { flag?: string }) {
    this.#requireWrite();
    const flag = options?.flag ?? "w";
    if (flag !== "w" && flag !== "wx") {
      throw new Error(`Workspace node:fs writeFile does not support flag ${JSON.stringify(flag)}.`);
    }
    const resolved = await this.#resolveSafe(path, true);
    const parent = resolved.slice(0, resolved.lastIndexOf("/")) || this.#root;
    await this.#assertSafeComponents(parent, false);
    await this.#fs.writeFile(resolved, content, { exclusive: flag === "wx" });
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    this.#requireWrite();
    const resolved = await this.#resolveSafe(path, true);
    await this.#fs.mkdir(resolved, options);
    await this.#assertSafeComponents(resolved, false);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    this.#requireWrite();
    return this.#fs.rm(await this.#resolveSafe(path, options?.force === true), options);
  }

  async chmod(path: string, mode: number) {
    this.#requireWrite();
    return this.#fs.chmod(await this.#resolveSafe(path), mode);
  }

  async symlink(target: string, path: string) {
    this.#requireWrite();
    const resolvedPath = await this.#resolveSafe(path, true);
    const parent = resolvedPath.slice(0, resolvedPath.lastIndexOf("/")) || this.#root;
    const candidateTarget = target.startsWith("/") ? target : `${parent}/${target}`;
    await this.#resolveSafe(candidateTarget, true);
    return this.#fs.symlink(target, resolvedPath);
  }

  resolveConfined(path: string, allowMissing = false) {
    return this.#resolveSafe(path, allowMissing);
  }

  resolve(path: string) {
    if (typeof path !== "string" || path.includes("\0")) {
      throw new Error("Workspace code paths must be strings without NUL bytes.");
    }
    const candidate = path.startsWith("/") ? path : `${this.#root}/${path}`;
    const parts: string[] = [];
    for (const part of candidate.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    const resolved = `/${parts.join("/")}`;
    if (this.#root !== "/" && resolved !== this.#root && !resolved.startsWith(`${this.#root}/`)) {
      throw new Error(`Workspace code paths must stay under ${this.#root}.`);
    }
    return resolved;
  }

  async #resolveSafe(path: string, allowMissing = false) {
    const resolved = this.resolve(path);
    await this.#assertSafeComponents(resolved, allowMissing);
    return resolved;
  }

  async #assertSafeComponents(path: string, allowMissing: boolean, allowFinalSymlink = false) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const [index, part] of parts.entries()) {
      current += `/${part}`;
      try {
        const stat = await this.#fs.lstat(current);
        const isFinal = index === parts.length - 1;
        if (stat.isSymbolicLink && !(allowFinalSymlink && isFinal)) {
          throw new Error(`Workspace code cannot traverse symbolic link ${current}.`);
        }
      } catch (error) {
        if (allowMissing && errorCode(error) === "ENOENT") return;
        throw error;
      }
    }
  }

  async #assertReadableSize(path: string) {
    const stat = await this.#fs.stat(path);
    if (stat.size > this.#maxReadBytes) {
      throw new Error(`Workspace runtime file read exceeds ${this.#maxReadBytes} bytes.`);
    }
  }

  #requireWrite() {
    if (this.#access !== "read-write") {
      throw new Error("Workspace code write access is not available.");
    }
  }
}

function normalizeRoot(root: string) {
  if (!root.startsWith("/")) throw new Error("Workspace code root must be absolute.");
  const normalized = root.replace(/\/+$/, "") || "/";
  if (normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Workspace code root must be normalized.");
  }
  return normalized;
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export function assertRuntimeValue(value: unknown): asserts value is WorkspaceRuntimeValue {
  assertValue(value, new WeakSet<object>());
}

function assertValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") {
    throw new Error("Workspace code inputs and results must be JSON-compatible values.");
  }
  if (seen.has(value)) throw new Error("Workspace code inputs and results cannot contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertValue(item, seen);
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Workspace code inputs and results must use plain objects.");
  }
  for (const item of Object.values(value)) assertValue(item, seen);
  seen.delete(value);
}
