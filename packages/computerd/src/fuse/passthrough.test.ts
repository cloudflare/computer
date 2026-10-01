import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FuseOps } from "./driver.js";
import { resolveMountIgnore } from "./ignore.js";
import { withLocalPassthrough } from "./passthrough.js";

// U2 (decision layer) and U3 (local I/O) for #179.
//
// These drive the real node:fs against a temp directory rather than a
// double. The module's whole purpose is to put bytes on a real
// filesystem, so a mock would be asserting the shape of the calls
// rather than the behaviour, and the interesting failures here -- EXDEV,
// ENOTEMPTY, parent creation -- are the filesystem's, not ours.

const MOUNT = "/workspace";

/** A VFS side that records what reached it and never succeeds quietly. */
function recordingOps(): { ops: FuseOps; calls: string[] } {
  const calls: string[] = [];
  const note =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      const cb = args[args.length - 1] as (code: number, value?: unknown) => void;
      // Shapes chosen so a leaked VFS call is visibly distinct from a
      // passthrough result rather than looking like a plausible answer.
      if (name === "readdir") cb(0, ["vfs-entry"]);
      else if (name === "getattr" || name === "fgetattr") cb(0, null);
      else if (name === "open" || name === "create" || name === "opendir") cb(0, 7);
      else if (name === "read" || name === "write") cb(0);
      else if (name === "readlink") cb(0, "vfs-link");
      else cb(0);
    };

  const ops = new Proxy({} as FuseOps, {
    get(_target, property: string) {
      if (property === "getBufferStats") return () => ({});
      return note(property);
    },
    has: () => true,
  });

  return { ops, calls };
}

describe("withLocalPassthrough: disabled", () => {
  test("returns the source ops untouched when no paths are configured", () => {
    const { ops } = recordingOps();
    const result = withLocalPassthrough(ops, {
      root: "/tmp/unused",
      ignore: resolveMountIgnore([]),
      mountPoint: MOUNT,
    });
    // Identity, not equivalence. A deployment without MOUNT_IGNORE
    // should pay nothing at all -- no wrapper, no branch per op.
    expect(result.ops).toBe(ops);
  });
});

describe("withLocalPassthrough: routing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const build = (paths: string[]) => {
    const source = recordingOps();
    const { ops, stats } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(paths, MOUNT),
      mountPoint: MOUNT,
    });
    return { ops, stats, calls: source.calls };
  };

  test("creates and reads a file on local disk, never touching the VFS", () => {
    const { ops, calls } = build(["node_modules"]);

    let fh = 0;
    ops.create("/node_modules/pkg/index.js", 0o644, (code, handle) => {
      expect(code).toBe(0);
      fh = handle as number;
    });

    const payload = Buffer.from("module.exports = 1\n");
    ops.write("/node_modules/pkg/index.js", fh, payload, payload.length, 0, (written) => {
      expect(written).toBe(payload.length);
    });
    ops.release("/node_modules/pkg/index.js", fh, (code) => expect(code).toBe(0));

    // The bytes are on the host filesystem, with the tree structure
    // preserved so a snapshot of the directory is interpretable.
    expect(readFileSync(join(root, "node_modules/pkg/index.js"), "utf8")).toBe(
      "module.exports = 1\n",
    );
    expect(calls).toEqual([]);

    let readBack = "";
    ops.open("/node_modules/pkg/index.js", 0, (code, handle) => {
      expect(code).toBe(0);
      const buffer = Buffer.alloc(64);
      ops.read("/node_modules/pkg/index.js", handle as number, buffer, 64, 0, (bytes) => {
        readBack = buffer.subarray(0, bytes as number).toString();
      });
    });
    expect(readBack).toBe("module.exports = 1\n");
  });

  test("creates missing parent directories on first write", () => {
    const { ops } = build(["node_modules"]);
    ops.create("/node_modules/a/b/c/deep.js", 0o644, (code) => expect(code).toBe(0));
    expect(readFileSync(join(root, "node_modules/a/b/c/deep.js"), "utf8")).toBe("");
  });

  test("passes non-ignored paths straight through to the VFS", () => {
    const { ops, calls } = build(["node_modules"]);
    ops.getattr("/src/main.ts", () => {});
    ops.create("/src/new.ts", 0o644, () => {});
    ops.unlink("/src/old.ts", () => {});
    expect(calls).toEqual(["getattr", "create", "unlink"]);
  });

  test("does not route a path that merely shares a prefix", () => {
    const { ops, calls } = build(["node_modules"]);
    ops.getattr("/node_modules_extra/x.js", () => {});
    expect(calls).toEqual(["getattr"]);
  });

  test("routes by handle, so a VFS handle is never served locally", () => {
    const { ops, calls } = build(["node_modules"]);
    const buffer = Buffer.alloc(8);
    // 7 is what the recording VFS hands out; it must stay with the VFS.
    ops.read("/src/main.ts", 7, buffer, 8, 0, () => {});
    expect(calls).toEqual(["read"]);
  });

  test("reports EBADF for an unknown local handle rather than guessing", () => {
    const { ops } = build(["node_modules"]);
    const buffer = Buffer.alloc(8);
    let code = 0;
    ops.read("/node_modules/x.js", 0x4000_0000 + 999, buffer, 8, 0, (result) => {
      code = result as number;
    });
    expect(code).toBe(-9);
  });
});

describe("withLocalPassthrough: the decision cache", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("inherits the decision rather than re-consulting the ignore set", () => {
    // The performance argument for the whole feature. A deep tree must
    // cost one decision at the top, not one per entry.
    const source = recordingOps();
    const { ops, stats } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    mkdirSync(join(root, "node_modules"), { recursive: true });
    ops.getattr("/node_modules", () => {});
    const afterRoot = stats().decisions;

    for (const path of [
      "/node_modules/a.js",
      "/node_modules/b.js",
      "/node_modules/c.js",
      "/node_modules/d.js",
    ]) {
      ops.getattr(path, () => {});
    }

    // Every child was answered from the parent's cached decision.
    expect(stats().decisions).toBe(afterRoot);
    expect(stats().cacheHits).toBe(4);
  });

  test("a file six levels deep costs one decision per new directory, not per file", () => {
    const source = recordingOps();
    const { ops, stats } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    // Materialise the chain the way a real install would.
    for (const dir of ["", "/a", "/a/b", "/a/b/c", "/a/b/c/d", "/a/b/c/d/e"]) {
      ops.mkdir(`/node_modules${dir}`, 0o755, () => {});
    }
    const afterTree = stats().decisions;
    const hitsAfterTree = stats().cacheHits;

    // Ten files in the deepest directory: all inherited.
    for (let index = 0; index < 10; index += 1) {
      ops.getattr(`/node_modules/a/b/c/d/e/file-${index}.js`, () => {});
    }

    expect(stats().decisions).toBe(afterTree);
    expect(stats().cacheHits - hitsAfterTree).toBe(10);
  });

  test("forgets a directory decision when the directory is removed", () => {
    // A stale cached decision would survive a delete and recreate,
    // which is how a path silently ends up in the wrong layer.
    const source = recordingOps();
    const { ops, stats } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    ops.mkdir("/node_modules", 0o755, () => {});
    ops.mkdir("/node_modules/pkg", 0o755, () => {});
    const hitsBefore = stats().cacheHits;
    ops.getattr("/node_modules/pkg/x.js", () => {});
    expect(stats().cacheHits - hitsBefore).toBe(1);

    ops.rmdir("/node_modules/pkg", () => {});
    const before = stats().decisions;
    ops.getattr("/node_modules/pkg/x.js", () => {});
    // Re-decided rather than inherited from the removed entry.
    expect(stats().decisions).toBe(before + 1);
  });
});

describe("withLocalPassthrough: rename", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const build = (paths: string[]) => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(paths, MOUNT),
      mountPoint: MOUNT,
      // Swallowed rather than left on console.warn: the crossing-rename
      // guidance is asserted in its own test above, and a suite that
      // prints it on every run trains people to ignore the output.
      warn: () => {},
    });
    return { ops, calls: source.calls };
  };

  test("renames within the local layer", () => {
    const { ops } = build(["node_modules"]);
    ops.create("/node_modules/.staging", 0o644, () => {});
    let code = -1;
    ops.rename("/node_modules/.staging", "/node_modules/final", (result) => {
      code = result as number;
    });
    expect(code).toBe(0);
    expect(readFileSync(join(root, "node_modules/final"), "utf8")).toBe("");
  });

  test("delegates a rename entirely within the VFS", () => {
    const { ops, calls } = build(["node_modules"]);
    ops.rename("/src/a.ts", "/src/b.ts", () => {});
    expect(calls).toEqual(["rename"]);
  });

  test("logs the fix once on the first crossing rename", () => {
    // The errno is all the kernel can carry, and "cross-device link" on
    // a path that is not a device is where an operator loses an
    // afternoon. The guidance has to reach them somewhere, so it goes
    // to the log -- and only once, because a build that does this does
    // it in a loop.
    const warnings: string[] = [];
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["dist"], MOUNT),
      mountPoint: MOUNT,
      warn: (message) => warnings.push(message),
    });

    ops.rename("/.tmp-build", "/dist", () => {});
    expect(warnings).toHaveLength(1);

    const [message] = warnings;
    expect(message).toMatch(/EXDEV/);
    // Which side is which, so the reader does not have to work it out.
    expect(message).toMatch(/\/dist is container-local/);
    expect(message).toMatch(/\/\.tmp-build is synced/);
    // Why it is not just done anyway.
    expect(message).toMatch(/cannot be atomic/);
    // And the actual fix: ignore the staging directory too.
    expect(message).toMatch(/add "\.tmp-build" to MOUNT_IGNORE/);

    // Repeats stay silent.
    ops.rename("/.tmp-build", "/dist", () => {});
    ops.rename("/dist/x", "/y", () => {});
    expect(warnings).toHaveLength(1);
  });

  test("counts every crossing rename even though it logs once", () => {
    const warnings: string[] = [];
    const source = recordingOps();
    const { ops, stats } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["dist"], MOUNT),
      mountPoint: MOUNT,
      warn: (message) => warnings.push(message),
    });

    ops.rename("/.tmp-build", "/dist", () => {});
    ops.rename("/.tmp-two", "/dist", () => {});
    expect(stats().crossLayerRenames).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("does not log for a rename that stays within one layer", () => {
    const warnings: string[] = [];
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["dist"], MOUNT),
      mountPoint: MOUNT,
      warn: (message) => warnings.push(message),
    });

    ops.create("/dist/a", 0o644, () => {});
    ops.rename("/dist/a", "/dist/b", () => {});
    ops.rename("/src/a.ts", "/src/b.ts", () => {});
    expect(warnings).toEqual([]);
  });

  test("returns EXDEV when a rename crosses the boundary", () => {
    // Not a copy. The two sides are different filesystems, so the
    // operation cannot be atomic, and faking it would turn a crash
    // mid-copy into a half-written file where the caller was promised
    // all-or-nothing. Tools fall back to copy-then-unlink on EXDEV.
    const { ops, calls } = build(["dist"]);

    let intoLocal = 0;
    ops.rename("/.tmp-build", "/dist", (code) => {
      intoLocal = code as number;
    });
    expect(intoLocal).toBe(-18);

    let outOfLocal = 0;
    ops.rename("/dist/app.js", "/app.js", (code) => {
      outOfLocal = code as number;
    });
    expect(outOfLocal).toBe(-18);

    // Neither reached the VFS: a partial rename there would be worse
    // than the error.
    expect(calls).toEqual([]);
  });
});

describe("withLocalPassthrough: directory listing", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("merges local-only children into a VFS directory listing", () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    mkdirSync(join(root, "node_modules"), { recursive: true });

    let names: string[] = [];
    ops.readdir("/", (code, result) => {
      expect(code).toBe(0);
      names = result as string[];
    });

    // Both sides are visible to a command inside the container, so both
    // sides appear.
    expect(names).toContain("vfs-entry");
    expect(names).toContain("node_modules");
  });

  test("does not show an entry that has not been materialised", () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    let names: string[] = [];
    ops.readdir("/", (_code, result) => {
      names = result as string[];
    });
    // Configured but never written: a phantom directory in `ls` would
    // be worse than its absence.
    expect(names).toEqual(["vfs-entry"]);
  });

  test("lists the local directory itself from disk", () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules/pkg/index.js"), "x");

    let names: string[] = [];
    ops.readdir("/node_modules/pkg", (code, result) => {
      expect(code).toBe(0);
      names = result as string[];
    });
    expect(names).toEqual(["index.js"]);
    expect(source.calls).toEqual([]);
  });
});

describe("withLocalPassthrough: symlinks", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("stores a link target verbatim without following it", () => {
    // The decision is made on the path, before any resolution, so a
    // symlink cannot drag a path between layers in either direction.
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });

    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    ops.symlink("../../../src/cli.ts", "/node_modules/.bin/tool", (code) => {
      expect(code).toBe(0);
    });

    let target = "";
    ops.readlink("/node_modules/.bin/tool", (code, result) => {
      expect(code).toBe(0);
      target = result as string;
    });
    // Escaping target preserved exactly; not resolved, not rewritten.
    expect(target).toBe("../../../src/cli.ts");
    expect(source.calls).toEqual([]);
  });

  test("a symlink outside the ignored tree still belongs to the VFS", () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });
    ops.symlink("node_modules/pkg", "/src/link", () => {});
    expect(source.calls).toEqual(["symlink"]);
  });
});

describe("withLocalPassthrough: errors", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const build = () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });
    return ops;
  };

  test("maps a missing file to ENOENT", () => {
    const ops = build();
    let code = 0;
    ops.getattr("/node_modules/missing.js", (result) => {
      code = result as number;
    });
    expect(code).toBe(-2);
  });

  test("maps a non-empty rmdir to ENOTEMPTY", () => {
    const ops = build();
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules/pkg/x.js"), "x");
    let code = 0;
    ops.rmdir("/node_modules/pkg", (result) => {
      code = result as number;
    });
    expect(code).toBe(-39);
  });

  test("maps a readdir of a file to ENOTDIR", () => {
    const ops = build();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules/file.js"), "x");
    let code = 0;
    ops.readdir("/node_modules/file.js", (result) => {
      code = result as number;
    });
    expect(code).toBe(-20);
  });
});
