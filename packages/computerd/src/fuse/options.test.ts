import { describe, expect, test } from "vitest";

import { buildFuseInitConfig, buildFuseMountOptions, type FuseOptionEnv } from "./options.js";

const empty: FuseOptionEnv = {};

describe("buildFuseMountOptions", () => {
  test("emits the production-safe profile when no env vars are set", () => {
    // attr_timeout and entry_timeout at one second cut metadata round
    // trips for tools that stat repeatedly (find, ls -l, git status)
    // without letting a stale view linger. negative_timeout at zero keeps
    // "file not found" answers fresh so a just-written file shows up
    // immediately. use_ino lets hard links stat as the same inode.
    //
    // No big_writes (libfuse 3 removed it, and batching is the default),
    // no max_write (an init field now), and no auto_cache: the keep-cache
    // decision moved into the driver so it can be skipped for a
    // passthrough handle, which the kernel refuses to combine with it.
    expect(buildFuseMountOptions(empty)).toEqual({
      useIno: true,
      maxRead: 524288,
      attrTimeout: 1,
      entryTimeout: 1,
      negativeTimeout: 0,
    });
  });

  test("max_write moves to the init config, not the mount options", () => {
    // libfuse 3 fails the mount if max_write arrives as a mount option.
    expect(buildFuseMountOptions(empty)).not.toHaveProperty("maxWrite");
    expect(buildFuseInitConfig(empty).maxWrite).toBe(524288);
  });

  test("requests a backing stack depth so an overlayfs store can register", () => {
    // Without this the ioctl fails ELOOP when MOUNT_IGNORE_PATH is on
    // overlayfs, which is the common Docker case.
    expect(buildFuseInitConfig(empty).maxBackingStackDepth).toBe(1);
  });

  test("overrides max_read and max_write from the environment", () => {
    const env = {
      COMPUTERD_FUSE_MAX_READ: "1048576",
      COMPUTERD_FUSE_MAX_WRITE: "1048576",
    };
    expect(buildFuseMountOptions(env).maxRead).toBe(1048576);
    expect(buildFuseInitConfig(env).maxWrite).toBe(1048576);
  });

  test("ignores non-numeric size overrides and falls back to the default", () => {
    expect(buildFuseMountOptions({ COMPUTERD_FUSE_MAX_READ: "wat" }).maxRead).toBe(524288);
  });

  test("rejects non-positive sizes", () => {
    expect(buildFuseMountOptions({ COMPUTERD_FUSE_MAX_READ: "0" }).maxRead).toBe(524288);
    expect(buildFuseInitConfig({ COMPUTERD_FUSE_MAX_WRITE: "-1" }).maxWrite).toBe(524288);
  });

  test("never sets auto_cache or kernel_cache", () => {
    // Both are incompatible with passthrough: libfuse applies keep_cache
    // after the open callback returns without checking, and the kernel
    // refuses FOPEN_KEEP_CACHE alongside FOPEN_PASSTHROUGH with EIO. The
    // driver decides keepCache per open instead.
    for (const env of [
      empty,
      { COMPUTERD_FUSE_EXTRA_OPTS: "auto_cache" },
      { COMPUTERD_FUSE_EXTRA_OPTS: "kernel_cache" },
    ]) {
      const out = buildFuseMountOptions(env);
      expect(out).not.toHaveProperty("autoCache");
      expect(out).not.toHaveProperty("kernelCache");
    }
  });

  test("strips options that would fail the mount", () => {
    // A typo in EXTRA_OPTS should not take the daemon down at startup.
    // ac_attr_timeout is refused by the binding unless auto_cache is on,
    // and auto_cache is never on.
    const out = buildFuseMountOptions({
      COMPUTERD_FUSE_EXTRA_OPTS:
        "big_writes,max_write=4096,writeback_cache,ac_attr_timeout=3,allow_other",
    });
    expect(Object.keys(out)).not.toContain("bigWrites");
    expect(Object.keys(out)).not.toContain("maxWrite");
    expect(Object.keys(out)).not.toContain("writebackCache");
    expect(Object.keys(out)).not.toContain("acAttrTimeout");
    // ...but anything legitimate still passes through.
    expect(out.allowOther).toBe(true);
  });

  test("drops metadata timeouts when explicitly disabled with an empty value", () => {
    const off = buildFuseMountOptions({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "",
      COMPUTERD_FUSE_ENTRY_TIMEOUT: "",
      COMPUTERD_FUSE_NEGATIVE_TIMEOUT: "",
    });
    expect(off).not.toHaveProperty("attrTimeout");
    expect(off).not.toHaveProperty("entryTimeout");
    expect(off).not.toHaveProperty("negativeTimeout");
  });

  test("overrides default metadata timeouts when explicit values are set", () => {
    const out = buildFuseMountOptions({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "5",
      COMPUTERD_FUSE_ENTRY_TIMEOUT: "4",
      COMPUTERD_FUSE_NEGATIVE_TIMEOUT: "2",
    });
    expect(out).toMatchObject({ attrTimeout: 5, entryTimeout: 4, negativeTimeout: 2 });
  });

  test("accepts fractional timeouts because libfuse documents them that way", () => {
    expect(buildFuseMountOptions({ COMPUTERD_FUSE_ATTR_TIMEOUT: "0.5" }).attrTimeout).toBe(0.5);
  });

  test("rejects non-numeric and negative timeouts", () => {
    expect(buildFuseMountOptions({ COMPUTERD_FUSE_ATTR_TIMEOUT: "nope" })).not.toHaveProperty(
      "attrTimeout",
    );
    expect(buildFuseMountOptions({ COMPUTERD_FUSE_ATTR_TIMEOUT: "-1" })).not.toHaveProperty(
      "attrTimeout",
    );
  });

  test("maps COMPUTERD_FUSE_EXTRA_OPTS onto the binding's option names", () => {
    // The binding takes typed options rather than a raw -o string, so a
    // libfuse spelling is translated: a bare flag becomes true, a number
    // stays a number, and anything else is passed as a string.
    const out = buildFuseMountOptions({
      COMPUTERD_FUSE_EXTRA_OPTS: "default_permissions,fsname=computerd,umask=18",
    });
    expect(out).toMatchObject({ defaultPermissions: true, fsname: "computerd", umask: 18 });
  });

  test("lets EXTRA_OPTS override a default rather than conflict with it", () => {
    const out = buildFuseMountOptions({ COMPUTERD_FUSE_EXTRA_OPTS: "max_read=131072" });
    expect(out.maxRead).toBe(131072);
  });

  test("returns the same options regardless of env var order", () => {
    const a = buildFuseMountOptions({
      COMPUTERD_FUSE_MAX_READ: "4096",
      COMPUTERD_FUSE_ATTR_TIMEOUT: "1",
    });
    const b = buildFuseMountOptions({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "1",
      COMPUTERD_FUSE_MAX_READ: "4096",
    });
    expect(a).toEqual(b);
  });
});

describe("the vendored binding", () => {
  // The binding validates its options object before it mounts, and an
  // unknown or conflicting name throws there rather than at libfuse.
  // Unit tests never mount, so this is the check that keeps the profile
  // and the binding in step.
  test("accepts the default profile and every documented override", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the vendored binding is CJS
    const fuseModule: any = await import("fuse-napi");
    const Fuse = fuseModule.default ?? fuseModule;
    for (const env of [
      empty,
      {
        COMPUTERD_FUSE_MAX_READ: "131072",
        COMPUTERD_FUSE_ATTR_TIMEOUT: "0.5",
        COMPUTERD_FUSE_ENTRY_TIMEOUT: "2",
        COMPUTERD_FUSE_NEGATIVE_TIMEOUT: "1",
        COMPUTERD_FUSE_EXTRA_OPTS: "allow_other,fsname=computerd,ac_attr_timeout=1",
      },
    ]) {
      const options = { autoUnmount: true, ...buildFuseMountOptions(env) };
      expect(() => Fuse.validateOptions(options)).not.toThrow();
    }
  });
});
