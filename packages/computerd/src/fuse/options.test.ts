import { describe, expect, test } from "vitest";

import { buildFuseInitConfig, buildFuseOptionString, type FuseOptionEnv } from "./options.js";

const empty: FuseOptionEnv = {};

describe("buildFuseOptionString", () => {
  test("emits the production-safe profile when no env vars are set", () => {
    // attr_timeout, entry_timeout and ac_attr_timeout at one second cut
    // metadata round-trips for tools that stat repeatedly (find, ls -l,
    // git status) without letting a stale view linger. negative_timeout
    // at zero keeps "file not found" answers fresh so a just-written file
    // shows up immediately. use_ino lets hardlinks stat as the same inode.
    //
    // No big_writes (libfuse 3 removed it, and batching is the default),
    // no max_write (an init field now), and no auto_cache: the keep-cache
    // decision moved into the driver so it can be skipped for a
    // passthrough handle, which the kernel refuses to combine with it.
    expect(buildFuseOptionString(empty)).toBe(
      "use_ino,max_read=524288,attr_timeout=1,entry_timeout=1,negative_timeout=0,ac_attr_timeout=1",
    );
  });

  test("max_write moves to the init config, not the option string", () => {
    // libfuse 3 fails the mount if max_write arrives as a mount option.
    expect(buildFuseOptionString(empty)).not.toContain("max_write");
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
    expect(buildFuseOptionString(env)).toContain("max_read=1048576");
    expect(buildFuseInitConfig(env).maxWrite).toBe(1048576);
  });

  test("ignores non-numeric size overrides and falls back to the default", () => {
    const out = buildFuseOptionString({ COMPUTERD_FUSE_MAX_READ: "wat" });
    expect(out).toContain("max_read=524288");
  });

  test("rejects non-positive sizes", () => {
    expect(buildFuseOptionString({ COMPUTERD_FUSE_MAX_READ: "0" })).toContain("max_read=524288");
    expect(buildFuseInitConfig({ COMPUTERD_FUSE_MAX_WRITE: "-1" }).maxWrite).toBe(524288);
  });

  test("never emits auto_cache or kernel_cache", () => {
    // Both are incompatible with passthrough: libfuse applies keep_cache
    // after the open callback returns without checking, and the kernel
    // refuses FOPEN_KEEP_CACHE alongside FOPEN_PASSTHROUGH with EIO. The
    // driver decides keepCache per open instead.
    for (const env of [
      empty,
      { COMPUTERD_FUSE_EXTRA_OPTS: "auto_cache" },
      { COMPUTERD_FUSE_EXTRA_OPTS: "kernel_cache" },
    ]) {
      const out = buildFuseOptionString(env);
      expect(out).not.toContain("auto_cache");
      expect(out).not.toContain("kernel_cache");
    }
  });

  test("strips options libfuse 3 would fail the mount on", () => {
    // A typo in EXTRA_OPTS should not take the daemon down at startup.
    const out = buildFuseOptionString({
      COMPUTERD_FUSE_EXTRA_OPTS: "big_writes,max_write=4096,writeback_cache,allow_other",
    });
    expect(out).not.toContain("big_writes");
    expect(out).not.toContain("max_write");
    expect(out).not.toContain("writeback_cache");
    // ...but anything legitimate still passes through.
    expect(out).toContain("allow_other");
  });

  test("drops metadata timeouts when explicitly disabled with zero", () => {
    const off = buildFuseOptionString({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "",
      COMPUTERD_FUSE_ENTRY_TIMEOUT: "",
      COMPUTERD_FUSE_AC_ATTR_TIMEOUT: "",
    });
    expect(off).not.toContain("attr_timeout");
    expect(off).not.toContain("entry_timeout");
    expect(off).not.toContain("ac_attr_timeout");
  });

  test("overrides default metadata timeouts when explicit values are set", () => {
    const out = buildFuseOptionString({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "5",
      COMPUTERD_FUSE_ENTRY_TIMEOUT: "4",
      COMPUTERD_FUSE_NEGATIVE_TIMEOUT: "2",
      COMPUTERD_FUSE_AC_ATTR_TIMEOUT: "3",
    });
    expect(out).toContain("attr_timeout=5");
    expect(out).toContain("entry_timeout=4");
    expect(out).toContain("negative_timeout=2");
    expect(out).toContain("ac_attr_timeout=3");
  });

  test("accepts fractional timeouts because libfuse documents them that way", () => {
    const out = buildFuseOptionString({ COMPUTERD_FUSE_ATTR_TIMEOUT: "0.5" });
    expect(out).toContain("attr_timeout=0.5");
  });

  test("rejects non-numeric timeouts", () => {
    // The substring "attr_timeout=" with the equals sign avoids
    // matching the ac_attr_timeout default that still emits.
    const out = buildFuseOptionString({ COMPUTERD_FUSE_ATTR_TIMEOUT: "nope" });
    expect(out).not.toMatch(/(?:^|,)attr_timeout=/);
  });

  test("rejects negative timeouts", () => {
    const out = buildFuseOptionString({ COMPUTERD_FUSE_ATTR_TIMEOUT: "-1" });
    expect(out).not.toMatch(/(?:^|,)attr_timeout=/);
  });

  test("appends COMPUTERD_FUSE_EXTRA_OPTS verbatim for last-resort experimentation", () => {
    const out = buildFuseOptionString({
      COMPUTERD_FUSE_EXTRA_OPTS: "use_ino,fsname=computerd",
    });
    expect(out).toContain("use_ino");
    expect(out).toContain("fsname=computerd");
  });

  test("does not emit writeback_cache even with EXTRA_OPTS asking for it", () => {
    // libfuse 2.9 (the version fuse-native links against) does not
    // recognise writeback_cache as a mount option; experiments showed
    // mount failing with "fuse: unknown option `writeback_cache'".
    // Strip it defensively so a typo in EXTRA_OPTS doesn't take the
    // daemon down.
    const out = buildFuseOptionString({
      COMPUTERD_FUSE_EXTRA_OPTS: "writeback_cache,use_ino",
    });
    expect(out).not.toContain("writeback_cache");
    expect(out).toContain("use_ino");
  });

  test("returns the same options regardless of env var order", () => {
    const a = buildFuseOptionString({
      COMPUTERD_FUSE_AUTO_CACHE: "1",
      COMPUTERD_FUSE_ATTR_TIMEOUT: "1",
    });
    const b = buildFuseOptionString({
      COMPUTERD_FUSE_ATTR_TIMEOUT: "1",
      COMPUTERD_FUSE_AUTO_CACHE: "1",
    });
    expect(a).toBe(b);
  });
});
