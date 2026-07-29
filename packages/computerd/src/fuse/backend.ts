import { access as defaultAccess } from "node:fs/promises";

// The user-facing `FUSE_MOUNT` env var. One knob, five values:
//
//   - auto   : probe `/dev/fuse` (linux) or macFUSE (darwin) and use
//              the real backend if available; fall back to the
//              userspace shim otherwise. Never errors. Default.
//   - fuse   : require the linux kernel FUSE backend.
//   - macfuse: require macFUSE on darwin.
//   - shim   : force the userspace shim. Works on any platform.
//   - none   : skip the mount entirely; HTTP + /api + /ws still come up.
export type FuseMountMode = "auto" | "fuse" | "macfuse" | "shim" | "none";

// The resolved backend selection. No `reason` field — the choice is
// explicit at this layer (either the user named it or `auto` picked
// it after a successful probe / a deliberate shim fallback).
export type FUSEBackend =
  | { kind: "fuse" }
  | { kind: "macfuse" }
  | { kind: "shim" }
  | { kind: "none" };

export interface ResolveFuseBackendOptions {
  access?: (path: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

const LINUX_FUSE_DEVICE = "/dev/fuse";
const MACFUSE_FILESYSTEM = "/Library/Filesystems/macfuse.fs";
const VALID_MODES: readonly FuseMountMode[] = ["auto", "fuse", "macfuse", "shim", "none"];

export function parseFuseMountMode(value: string | undefined): FuseMountMode {
  if (value === undefined || value === "") return "auto";
  if ((VALID_MODES as readonly string[]).includes(value)) {
    return value as FuseMountMode;
  }
  throw new Error(
    `FUSE_MOUNT must be one of ${VALID_MODES.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

export async function resolveFuseBackend(
  mode: FuseMountMode,
  options: ResolveFuseBackendOptions = {},
): Promise<FUSEBackend> {
  const access = options.access ?? defaultAccess;
  const platform = options.platform ?? process.platform;

  if (mode === "none") return { kind: "none" };
  if (mode === "shim") return { kind: "shim" };

  if (mode === "fuse") {
    if (platform !== "linux") {
      throw new Error(`FUSE_MOUNT=fuse requires linux; got platform ${platform}`);
    }
    if (!(await canAccess(access, LINUX_FUSE_DEVICE))) {
      throw new Error(
        `FUSE_MOUNT=fuse is set but ${LINUX_FUSE_DEVICE} is not accessible; set FUSE_MOUNT=shim or FUSE_MOUNT=none to bypass`,
      );
    }
    return { kind: "fuse" };
  }

  if (mode === "macfuse") {
    if (platform !== "darwin") {
      throw new Error(`FUSE_MOUNT=macfuse requires macOS; got platform ${platform}`);
    }
    if (!(await canAccess(access, MACFUSE_FILESYSTEM))) {
      throw new Error(
        `FUSE_MOUNT=macfuse is set but macFUSE is not installed; install macFUSE or set FUSE_MOUNT=shim`,
      );
    }
    return { kind: "macfuse" };
  }

  // mode === "auto"
  if (platform === "linux" && (await canAccess(access, LINUX_FUSE_DEVICE))) {
    return { kind: "fuse" };
  }
  if (platform === "darwin" && (await canAccess(access, MACFUSE_FILESYSTEM))) {
    return { kind: "macfuse" };
  }
  return { kind: "shim" };
}

async function canAccess(access: (path: string) => Promise<void>, path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
