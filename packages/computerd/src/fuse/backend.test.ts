import { expect, test } from "vitest";

import { parseFuseMountMode, resolveFuseBackend } from "./index.js";

function accessFor(paths: string[]) {
  const accessible = new Set(paths);
  return async (path: string) => {
    if (!accessible.has(path)) {
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    }
  };
}

// ---------- parseFuseMountMode ----------------------------------

test("parseFuseMountMode defaults to auto when undefined or empty", () => {
  expect(parseFuseMountMode(undefined)).toBe("auto");
  expect(parseFuseMountMode("")).toBe("auto");
});

test("parseFuseMountMode accepts each valid value", () => {
  for (const value of ["auto", "fuse", "macfuse", "shim", "none"] as const) {
    expect(parseFuseMountMode(value)).toBe(value);
  }
});

test("parseFuseMountMode rejects unknown values", () => {
  expect(() => parseFuseMountMode("bogus")).toThrow(
    /FUSE_MOUNT must be one of auto, fuse, macfuse, shim, none; got "bogus"/,
  );
});

// ---------- resolveFuseBackend: auto ----------------------------

test("resolveFuseBackend(auto) picks fuse on linux with /dev/fuse", async () => {
  expect(
    await resolveFuseBackend("auto", {
      access: accessFor(["/dev/fuse"]),
      platform: "linux",
    }),
  ).toEqual({ kind: "fuse" });
});

test("resolveFuseBackend(auto) falls back to shim on linux without /dev/fuse", async () => {
  expect(
    await resolveFuseBackend("auto", {
      access: accessFor([]),
      platform: "linux",
    }),
  ).toEqual({ kind: "shim" });
});

test("resolveFuseBackend(auto) picks macfuse on darwin when installed", async () => {
  expect(
    await resolveFuseBackend("auto", {
      access: accessFor(["/Library/Filesystems/macfuse.fs"]),
      platform: "darwin",
    }),
  ).toEqual({ kind: "macfuse" });
});

test("resolveFuseBackend(auto) falls back to shim on darwin without macFUSE", async () => {
  expect(
    await resolveFuseBackend("auto", {
      access: accessFor([]),
      platform: "darwin",
    }),
  ).toEqual({ kind: "shim" });
});

test("resolveFuseBackend(auto) falls back to shim on unsupported platforms", async () => {
  expect(
    await resolveFuseBackend("auto", {
      access: accessFor([]),
      platform: "win32",
    }),
  ).toEqual({ kind: "shim" });
});

// ---------- resolveFuseBackend: fuse ----------------------------

test("resolveFuseBackend(fuse) returns fuse on linux with /dev/fuse", async () => {
  expect(
    await resolveFuseBackend("fuse", {
      access: accessFor(["/dev/fuse"]),
      platform: "linux",
    }),
  ).toEqual({ kind: "fuse" });
});

test("resolveFuseBackend(fuse) throws on linux without /dev/fuse", async () => {
  await expect(
    resolveFuseBackend("fuse", {
      access: accessFor([]),
      platform: "linux",
    }),
  ).rejects.toThrow(/FUSE_MOUNT=fuse.*\/dev\/fuse/);
});

test("resolveFuseBackend(fuse) throws on non-linux platforms", async () => {
  await expect(
    resolveFuseBackend("fuse", {
      access: accessFor(["/dev/fuse"]),
      platform: "darwin",
    }),
  ).rejects.toThrow(/FUSE_MOUNT=fuse.*linux/);
});

// ---------- resolveFuseBackend: macfuse -------------------------

test("resolveFuseBackend(macfuse) returns macfuse on darwin when installed", async () => {
  expect(
    await resolveFuseBackend("macfuse", {
      access: accessFor(["/Library/Filesystems/macfuse.fs"]),
      platform: "darwin",
    }),
  ).toEqual({ kind: "macfuse" });
});

test("resolveFuseBackend(macfuse) throws on darwin without macFUSE", async () => {
  await expect(
    resolveFuseBackend("macfuse", {
      access: accessFor([]),
      platform: "darwin",
    }),
  ).rejects.toThrow(/FUSE_MOUNT=macfuse.*macFUSE/);
});

test("resolveFuseBackend(macfuse) throws on non-darwin platforms", async () => {
  await expect(
    resolveFuseBackend("macfuse", {
      access: accessFor(["/Library/Filesystems/macfuse.fs"]),
      platform: "linux",
    }),
  ).rejects.toThrow(/FUSE_MOUNT=macfuse.*macOS/);
});

// ---------- resolveFuseBackend: shim / none ---------------------

test("resolveFuseBackend(shim) returns shim without probing", async () => {
  expect(
    await resolveFuseBackend("shim", {
      access: async () => {
        throw new Error("should not probe");
      },
      platform: "linux",
    }),
  ).toEqual({ kind: "shim" });
});

test("resolveFuseBackend(none) returns none without probing", async () => {
  expect(
    await resolveFuseBackend("none", {
      access: async () => {
        throw new Error("should not probe");
      },
      platform: "linux",
    }),
  ).toEqual({ kind: "none" });
});
