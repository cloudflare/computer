export type WorkspaceErrorCode =
  | "ENOENT"
  | "ENOTEMPTY"
  | "ENOTDIR"
  | "EISDIR"
  | "EEXIST"
  | "EINVAL"
  | "EACCES"
  | "EPERM"
  | "EROFS"
  | "ENOSYS"
  | "EBADF"
  | "ELOOP"
  | "EUNKNOWN_HASH"
  | "EIO";

export interface WorkspaceFsError extends Error {
  code: WorkspaceErrorCode;
  path?: string;
}

export function createWorkspaceError(
  code: WorkspaceErrorCode,
  message: string,
  path?: string,
): WorkspaceFsError {
  // Many callers already end the message with the path. Name it once.
  const named = path === undefined || message.endsWith(path) ? message : `${message}: ${path}`;
  const error = new Error(named) as WorkspaceFsError;
  error.name = "WorkspaceFsError";
  error.code = code;
  error.path = path;
  return error;
}

export function invalidPath(path: string, reason: string): WorkspaceFsError {
  return createWorkspaceError("EINVAL", `Invalid path (${reason})`, path);
}
