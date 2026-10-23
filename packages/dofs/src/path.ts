import { invalidPath } from "./errors";

export interface CanonicalPath {
  path: string;
  parts: string[];
  name: string;
  parentPath: string | undefined;
}

export function canonicalizePath(path: string): CanonicalPath {
  if (path.length === 0) {
    throw invalidPath(path, "empty");
  }

  if (!path.startsWith("/")) {
    throw invalidPath(path, "must be absolute");
  }

  if (path.includes("\0")) {
    throw invalidPath(path, "contains NUL byte");
  }

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.length === 0) {
        throw invalidPath(path, "escapes root");
      }
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  const canonical = parts.length === 0 ? "/" : `/${parts.join("/")}`;
  const name = parts.length === 0 ? "" : parts[parts.length - 1];
  const parentParts = parts.slice(0, -1);
  const parentPath =
    parts.length === 0 ? undefined : parentParts.length === 0 ? "/" : `/${parentParts.join("/")}`;

  return {
    path: canonical,
    parts,
    name,
    parentPath,
  };
}
