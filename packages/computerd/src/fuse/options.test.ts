import { describe, expect, test } from "vitest";

import {
  buildFuseInitConfig,
  buildFuseMountOptions,
  type FuseOptionEnv,
  passthroughRequested,
} from "./options.js";

const empty: FuseOptionEnv = {};

describe("buildFuseMountOptions", () => {
  test("emits the production-safe profile when no env vars are set", () => {
    expect(buildFuseMountOptions(empty)).toEqual({
      useIno: true,
      maxRead: 524288,
      attrTimeout: 1,
      entryTimeout: 1,
      negativeTimeout: 0,
    });
  });

  test("max_write moves to the init config, not the mount options", () => {
    expect(buildFuseMountOptions(empty)).not.toHaveProperty("maxWrite");
    expect(buildFuseInitConfig(empty).maxWrite).toBe(524288);
  });

  test("requests a backing stack depth so an overlayfs store can register", () => {
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
    const out = buildFuseMountOptions({
      COMPUTERD_FUSE_EXTRA_OPTS:
        "big_writes,max_write=4096,writeback_cache,ac_attr_timeout=3,allow_other",
    });
    expect(Object.keys(out)).not.toContain("bigWrites");
    expect(Object.keys(out)).not.toContain("maxWrite");
    expect(Object.keys(out)).not.toContain("writebackCache");
    expect(Object.keys(out)).not.toContain("acAttrTimeout");
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
  // Unit tests never mount, so this is what catches an option the binding
  // would refuse.
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

describe("passthroughRequested", () => {
  test("is on by default", () => {
    expect(passthroughRequested(empty)).toBe(true);
  });

  test("turns off with any of the usual negative spellings", () => {
    for (const value of ["0", "false", "no", "off", "FALSE", " off "]) {
      expect(passthroughRequested({ COMPUTERD_FUSE_PASSTHROUGH: value })).toBe(false);
    }
  });

  test("stays on for anything else, so a typo cannot quietly cost speed", () => {
    for (const value of ["1", "true", "yes", "on", ""]) {
      expect(passthroughRequested({ COMPUTERD_FUSE_PASSTHROUGH: value })).toBe(true);
    }
  });
});
