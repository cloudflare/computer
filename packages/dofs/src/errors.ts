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
  | "ENOTSUP"
  | "EBUSY"
  | "EXDEV"
  | "ENOSPC"
  | "EBADF"
  | "ELOOP"
  | "EUNKNOWN_HASH"
  | "EIO";

const WORKSPACE_ERROR_CODES: ReadonlySet<string> = new Set<WorkspaceErrorCode>([
  "ENOENT",
  "ENOTEMPTY",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EINVAL",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSYS",
  "ENOTSUP",
  "EBUSY",
  "EXDEV",
  "ENOSPC",
  "EBADF",
  "ELOOP",
  "EUNKNOWN_HASH",
  "EIO",
]);

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

// True for an error that carries one of the codes above, whether
// createWorkspaceError made it or not: code that serves files from
// elsewhere, a passthrough mount, reports ENOENT or ENOTDIR this way.
export function isWorkspaceError(error: unknown): error is WorkspaceFsError {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Partial<WorkspaceFsError>).code;
  return typeof code === "string" && WORKSPACE_ERROR_CODES.has(code);
}
