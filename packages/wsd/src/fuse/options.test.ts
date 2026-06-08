import { describe, expect, test } from "vitest";

import { buildFuseOptionString, type FuseOptionEnv } from "./options.js";

const empty: FuseOptionEnv = {};

describe("buildFuseOptionString", () => {
  test("emits the production-safe profile when no env vars are set", () => {
    // Defaults derived from the handoff benchmark report and the
    // mtime-propagation contract tests on the apply path. auto_cache
    // is the production-safe page-cache option: the kernel keeps
    // cached pages until the file is reopened with a different
    // mtime or size, at which point it drops them and re-reads
    // through FUSE. attr_timeout, entry_timeout, and
    // ac_attr_timeout at one second cut metadata round-trips for
    // tools that stat repeatedly (find, ls -l, git status) without
    // letting a stale view linger. negative_timeout at zero keeps
    // "file not found" answers fresh so a just-written file shows
    // up immediately. use_ino lets hardlinks stat as the same inode.
    // big_writes plus 128 KiB max_read and max_write match the
    // historical sizing that earlier experiments showed didn't move
    // on bigger values.
    expect(buildFuseOptionString(empty)).toBe(
      "big_writes,use_ino,max_write=131072,max_read=131072,auto_cache,attr_timeout=1,entry_timeout=1,negative_timeout=0,ac_attr_timeout=1",
    );
  });

  test("overrides max_read and max_write from the environment", () => {
    const out = buildFuseOptionString({
      WSD_FUSE_MAX_READ: "1048576",
      WSD_FUSE_MAX_WRITE: "1048576",
    });
    expect(out).toContain("max_write=1048576");
    expect(out).toContain("max_read=1048576");
    expect(out).not.toContain("max_write=131072");
  });

  test("ignores non-numeric size overrides and falls back to the default", () => {
    const out = buildFuseOptionString({ WSD_FUSE_MAX_READ: "wat" });
    expect(out).toContain("max_read=131072");
  });

  test("rejects non-positive sizes", () => {
    const a = buildFuseOptionString({ WSD_FUSE_MAX_READ: "0" });
    expect(a).toContain("max_read=131072");
    const b = buildFuseOptionString({ WSD_FUSE_MAX_WRITE: "-1" });
    expect(b).toContain("max_write=131072");
  });

  test("keeps auto_cache when WSD_FUSE_AUTO_CACHE is truthy or unset", () => {
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "1" })).toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "true" })).toContain("auto_cache");
    expect(buildFuseOptionString(empty)).toContain("auto_cache");
  });

  test("drops auto_cache when WSD_FUSE_AUTO_CACHE is explicitly disabled", () => {
    // Operators who hit a correctness issue under auto_cache need
    // a way to turn it off without rebuilding. Explicit "0" /
    // "false" / "no" / "off" disables it; an empty string is
    // treated the same way because that's what an unset env var
    // looks like once it reaches the shell.
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "0" })).not.toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "false" })).not.toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "" })).not.toContain("auto_cache");
  });

  test("drops metadata timeouts when explicitly disabled with zero", () => {
    // Same opt-out story as auto_cache. "0" or empty turns the
    // default off; anything positive overrides the default value.
    const off = buildFuseOptionString({
      WSD_FUSE_ATTR_TIMEOUT: "",
      WSD_FUSE_ENTRY_TIMEOUT: "",
      WSD_FUSE_AC_ATTR_TIMEOUT: "",
    });
    expect(off).not.toContain("attr_timeout");
    expect(off).not.toContain("entry_timeout");
    expect(off).not.toContain("ac_attr_timeout");
  });

  test("WSD_FUSE_KERNEL_CACHE=1 alone loses to the default auto_cache", () => {
    // The auto_cache default is sticky. Setting only kernel_cache
    // looks like asking for both, and the mutual-exclusion rule
    // resolves in favor of auto_cache. Operators who want the
    // fast / single-writer profile must also disable auto_cache,
    // which the next test pins.
    const out = buildFuseOptionString({ WSD_FUSE_KERNEL_CACHE: "1" });
    expect(out).toContain("auto_cache");
    expect(out).not.toContain("kernel_cache");
  });

  test("treats auto_cache and kernel_cache as mutually exclusive, with auto_cache winning", () => {
    // libfuse 2.9 documents kernel_cache and auto_cache as incompatible:
    // auto_cache implies the page cache is valid until invalidated, and
    // kernel_cache implies the page cache is never invalidated. Asking for
    // both is a configuration mistake. We prefer the safer (auto_cache)
    // option and warn-by-fact: the option string will say auto_cache only.
    const out = buildFuseOptionString({
      WSD_FUSE_AUTO_CACHE: "1",
      WSD_FUSE_KERNEL_CACHE: "1",
    });
    expect(out).toContain("auto_cache");
    expect(out).not.toContain("kernel_cache");
  });

  test("kernel_cache replaces the default auto_cache when only kernel_cache is set", () => {
    // Single-writer / fast profile: opt out of auto_cache and opt
    // in to kernel_cache in one move. Without the explicit
    // auto_cache=0 the operator would get both env vars truthy
    // and silently fall back to the safer default, defeating the
    // intent. Document the working incantation here.
    const out = buildFuseOptionString({
      WSD_FUSE_AUTO_CACHE: "0",
      WSD_FUSE_KERNEL_CACHE: "1",
    });
    expect(out).toContain("kernel_cache");
    expect(out).not.toContain("auto_cache");
  });

  test("overrides default metadata timeouts when explicit values are set", () => {
    const out = buildFuseOptionString({
      WSD_FUSE_ATTR_TIMEOUT: "5",
      WSD_FUSE_ENTRY_TIMEOUT: "4",
      WSD_FUSE_NEGATIVE_TIMEOUT: "2",
      WSD_FUSE_AC_ATTR_TIMEOUT: "3",
    });
    expect(out).toContain("attr_timeout=5");
    expect(out).toContain("entry_timeout=4");
    expect(out).toContain("negative_timeout=2");
    expect(out).toContain("ac_attr_timeout=3");
  });

  test("accepts fractional timeouts because libfuse documents them that way", () => {
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "0.5" });
    expect(out).toContain("attr_timeout=0.5");
  });

  test("rejects non-numeric timeouts", () => {
    // The substring "attr_timeout=" with the equals sign avoids
    // matching the ac_attr_timeout default that still emits.
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "nope" });
    expect(out).not.toMatch(/(?:^|,)attr_timeout=/);
  });

  test("rejects negative timeouts", () => {
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "-1" });
    expect(out).not.toMatch(/(?:^|,)attr_timeout=/);
  });

  test("appends WSD_FUSE_EXTRA_OPTS verbatim for last-resort experimentation", () => {
    const out = buildFuseOptionString({
      WSD_FUSE_EXTRA_OPTS: "use_ino,fsname=wsd",
    });
    expect(out).toContain("use_ino");
    expect(out).toContain("fsname=wsd");
  });

  test("does not emit writeback_cache even with EXTRA_OPTS asking for it", () => {
    // libfuse 2.9 (the version fuse-native links against) does not
    // recognise writeback_cache as a mount option; experiments showed
    // mount failing with "fuse: unknown option `writeback_cache'".
    // Strip it defensively so a typo in EXTRA_OPTS doesn't take the
    // daemon down.
    const out = buildFuseOptionString({
      WSD_FUSE_EXTRA_OPTS: "writeback_cache,use_ino",
    });
    expect(out).not.toContain("writeback_cache");
    expect(out).toContain("use_ino");
  });

  test("returns the same options regardless of env var order", () => {
    const a = buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "1", WSD_FUSE_ATTR_TIMEOUT: "1" });
    const b = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "1", WSD_FUSE_AUTO_CACHE: "1" });
    expect(a).toBe(b);
  });
});
