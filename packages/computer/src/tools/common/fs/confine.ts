const PATH_ARGUMENT: Readonly<Record<string, number>> = {
  stat: 0,
  lstat: 0,
  readFile: 0,
  writeFile: 0,
  mkdir: 0,
  rm: 0,
  find: 0,
  readdir: 0,
  readlink: 0,
  grep: 1,
};

interface ConfinableFs {
  lstat?(path: string): Promise<{ isSymbolicLink?: boolean }>;
}

interface ConfinableWorkspace {
  fs: object;
  runtime?: unknown;
  assets?: { share(path: string, options: never): Promise<string> };
  sessionId?: string | null;
}

export function normalizeRootedPath(root: string, input: string): string {
  const base = normalizeAbsolute(root);
  const absolute = normalizeAbsolute(input.startsWith("/") ? input : `${base}/${input}`);
  if (base !== "/" && absolute !== base && !absolute.startsWith(`${base}/`)) {
    throw new Error(`Path is outside ${base}: ${input}`);
  }
  return absolute;
}

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const confinedFilesystems = new WeakMap<object, Map<string, object>>();

export function confineWorkspace<W extends ConfinableWorkspace>(workspace: W, root: string): W {
  const base = normalizeAbsolute(root);
  const fs = workspace.fs as ConfinableFs & Record<string, unknown>;
  const byRoot = confinedFilesystems.get(fs) ?? new Map<string, object>();
  confinedFilesystems.set(fs, byRoot);

  const resolve = async (input: unknown): Promise<string> => {
    if (typeof input !== "string") throw new TypeError("path must be a string");
    const path = normalizeRootedPath(base, input);
    if (typeof fs.lstat !== "function") return path;
    let current = base === "/" ? "" : base;
    for (const part of path.slice(current.length).split("/").filter(Boolean)) {
      current = `${current}/${part}`;
      let info: { isSymbolicLink?: boolean };
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (isMissing(error)) return path;
        throw error;
      }
      if (info.isSymbolicLink === true) {
        throw new Error(`Path contains a symbolic link: ${current}`);
      }
    }
    return path;
  };

  const confinedFs =
    byRoot.get(base) ??
    new Proxy(fs, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const index = typeof property === "string" ? PATH_ARGUMENT[property] : undefined;
        if (index === undefined) return value.bind(target);
        return async (...args: unknown[]) => {
          const next = [...args];
          next[index] = await resolve(args[index]);
          return value.apply(target, next);
        };
      },
    });
  byRoot.set(base, confinedFs);

  const assets = workspace.assets;
  const confinedAssets =
    assets === undefined
      ? undefined
      : {
          share: async (path: string, options: never) => assets.share(await resolve(path), options),
        };

  return new Proxy(workspace, {
    get(target, property) {
      if (property === "fs") return confinedFs;
      if (property === "assets") return confinedAssets;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "ENOENT") return true;
  return typeof candidate.message === "string" && /ENOENT|no such/i.test(candidate.message);
}
