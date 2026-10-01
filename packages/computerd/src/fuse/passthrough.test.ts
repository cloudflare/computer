import * as nodeFs from "node:fs";
import {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FuseOps } from "./driver.js";
import { resolveMountIgnore } from "./ignore.js";
import { type PassthroughFs, withLocalPassthrough } from "./passthrough.js";

// The real filesystem, as the slice withLocalPassthrough takes. Tests
// override single calls on top of it.
const realFs = (): PassthroughFs => ({ ...nodeFs }) as PassthroughFs;

// Drives the real node:fs against a temp directory rather than a double.
// The interesting failures here -- EXDEV, ENOTEMPTY, parent creation --
// are the filesystem's, so a mock would assert the shape of the calls
// rather than the behavior.

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

describe("withLocalPassthrough: deciding paths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("routes a path many levels under an entry", () => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });
    ops.create("/node_modules/a/b/c/d/e/f.js", 0o644, (code) => expect(code).toBe(0));
    expect(readFileSync(join(root, "node_modules/a/b/c/d/e/f.js"), "utf8")).toBe("");
    expect(source.calls).toEqual([]);
  });

  test("a recreated directory is decided by its path, not by history", () => {
    // Removing and recreating a directory, or renaming one into place,
    // must not leave a path in the layer it used to belong to.
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
    });
    ops.mkdir("/node_modules", 0o755, () => {});
    ops.mkdir("/node_modules/pkg", 0o755, () => {});
    ops.rename("/node_modules/pkg", "/node_modules/moved", (code) => expect(code).toBe(0));
    ops.rmdir("/node_modules/moved", (code) => expect(code).toBe(0));

    ops.getattr("/src/pkg/x.js", () => {});
    expect(source.calls).toEqual(["getattr"]);
  });

  test("does not touch local disk to decide a synced path", () => {
    // Every VFS lookup goes through the decision, so a syscall here is
    // paid on every getattr in the synced tree.
    const source = recordingOps();
    let localCalls = 0;
    const counting = new Proxy(realFs(), {
      get(target, property: keyof PassthroughFs) {
        localCalls += 1;
        return target[property];
      },
    });
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
      fs: counting,
    });
    for (let index = 0; index < 10; index += 1) ops.getattr(`/src/file-${index}.ts`, () => {});
    expect(localCalls).toBe(0);
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
    // all-or-nothing. EXDEV is what rename(2) returns between any two
    // filesystems.
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

  test("does not show an entry that has not been materialized", () => {
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

describe("withLocalPassthrough: descriptor and metadata operations", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "computerd-passthrough-"));
    outside = mkdtempSync(join(tmpdir(), "computerd-outside-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const build = (fs?: Partial<PassthroughFs>) => {
    const source = recordingOps();
    const { ops } = withLocalPassthrough(source.ops, {
      root,
      ignore: resolveMountIgnore(["node_modules"], MOUNT),
      mountPoint: MOUNT,
      ...(fs === undefined ? {} : { fs: { ...realFs(), ...fs } }),
    });
    return { ops, calls: source.calls };
  };

  const open = (ops: FuseOps, path: string): number => {
    let fh = 0;
    ops.open(path, constants.O_RDWR, (code, handle) => {
      expect(code).toBe(0);
      fh = handle as number;
    });
    return fh;
  };

  const status = (run: (cb: (code: number) => void) => void): number => {
    let result = 1;
    run((code) => {
      result = code;
    });
    return result;
  };

  test("ftruncate truncates the open file, not whatever now has its name", () => {
    // Open a, rename it to b, create a new a, then truncate the old
    // handle. The handle still refers to the file now called b.
    const { ops } = build();
    writeFileSync(join(root, "node_modules/a"), "original");
    const fh = open(ops, "/node_modules/a");
    ops.rename("/node_modules/a", "/node_modules/b", (code) => expect(code).toBe(0));
    writeFileSync(join(root, "node_modules/a"), "replacement");

    expect(status((cb) => ops.ftruncate("/node_modules/a", fh, 2, cb))).toBe(0);

    expect(readFileSync(join(root, "node_modules/b"), "utf8")).toBe("or");
    expect(readFileSync(join(root, "node_modules/a"), "utf8")).toBe("replacement");
  });

  test("fsync flushes the descriptor", () => {
    // A program that fsyncs a file is relying on it reaching disk.
    const synced: string[] = [];
    const { ops } = build({
      fsyncSync: () => {
        synced.push("fsync");
      },
      fdatasyncSync: () => {
        synced.push("fdatasync");
      },
    });
    writeFileSync(join(root, "node_modules/a"), "x");
    const fh = open(ops, "/node_modules/a");

    expect(status((cb) => ops.fsync("/node_modules/a", fh, 0, cb))).toBe(0);
    expect(status((cb) => ops.fsync("/node_modules/a", fh, 1, cb))).toBe(0);
    expect(synced).toEqual(["fsync", "fdatasync"]);
  });

  test("hardlinks within the local layer", () => {
    const { ops, calls } = build();
    writeFileSync(join(root, "node_modules/a"), "shared");

    expect(status((cb) => ops.link("/node_modules/a", "/node_modules/b", cb))).toBe(0);

    expect(statSync(join(root, "node_modules/b")).nlink).toBe(2);
    expect(calls).toEqual([]);
  });

  test("refuses a hardlink across the boundary with EXDEV", () => {
    const { ops, calls } = build();
    writeFileSync(join(root, "node_modules/a"), "x");

    expect(status((cb) => ops.link("/node_modules/a", "/src/a", cb))).toBe(-18);
    expect(status((cb) => ops.link("/src/a", "/node_modules/b", cb))).toBe(-18);
    expect(calls).toEqual([]);
  });

  test("delegates a hardlink entirely within the VFS", () => {
    const { ops, calls } = build();
    ops.link("/src/a", "/src/b", () => {});
    expect(calls).toEqual(["link"]);
  });

  test("opendir reports a missing path or a file up front", () => {
    const { ops } = build();
    writeFileSync(join(root, "node_modules/file.js"), "x");

    expect(status((cb) => ops.opendir("/node_modules/missing", 0, cb))).toBe(-2);
    expect(status((cb) => ops.opendir("/node_modules/file.js", 0, cb))).toBe(-20);
    expect(status((cb) => ops.opendir("/node_modules", 0, cb))).toBe(0);
  });

  test("access checks the requested mode", () => {
    const { ops } = build();
    writeFileSync(join(root, "node_modules/data.json"), "{}", { mode: 0o644 });

    expect(status((cb) => ops.access("/node_modules/data.json", constants.R_OK, cb))).toBe(0);
    // No execute bit for anyone, so this fails even for root.
    expect(status((cb) => ops.access("/node_modules/data.json", constants.X_OK, cb))).toBe(-13);
  });

  test("utimens on a symlink changes the link, not its target", () => {
    // The kernel resolves links before calling the daemon unless the
    // caller asked for the link itself (touch -h). Following it here
    // would reach a file outside the local root.
    const { ops } = build();
    const target = join(outside, "target");
    writeFileSync(target, "x");
    const before = statSync(target).mtimeMs;
    symlinkSync(target, join(root, "node_modules/link"));

    expect(status((cb) => ops.utimens("/node_modules/link", 1_000, 1_000, cb))).toBe(0);

    expect(statSync(target).mtimeMs).toBe(before);
    expect(lstatSync(join(root, "node_modules/link")).mtimeMs).toBe(1_000);
  });

  test("chown on a symlink changes the link, not its target", () => {
    // Changing ownership needs root, so this checks which call is made.
    const changed: string[] = [];
    const { ops } = build({
      chownSync: () => {
        changed.push("chown");
      },
      lchownSync: () => {
        changed.push("lchown");
      },
    });
    symlinkSync(join(outside, "target"), join(root, "node_modules/link"));

    expect(status((cb) => ops.chown("/node_modules/link", 0, 0, cb))).toBe(0);
    expect(changed).toEqual(["lchown"]);
  });
});
