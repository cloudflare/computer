import { describe, expect, test } from "vitest";

import { resolveMountIgnore } from "./ignore.js";
import { createNativeRoots, type NativeRootsOptions, unescapeMountinfo } from "./native-roots.js";

const ROOT = "/tmp/workspace";
const MOUNT = "/workspace";

interface Harness {
  roots: ReturnType<typeof createNativeRoots>;
  commands: string[][];
  mounted: Set<string>;
  warnings: string[];
}

/**
 * A fake system: `dirs` is the backing tree (paths relative to ROOT),
 * A confined bind adds the target to the fake mount table.
 */
function harness(
  options: {
    ignore?: string[];
    dirs?: string[];
    files?: string[];
    symlinks?: string[];
    mountExit?: number;
    mismatch?: boolean;
    active?: () => boolean;
    /** Mount-relative targets that do not exist under the mount yet. */
    missingTargets?: Set<string>;
    beforeTarget?: () => Promise<void>;
    beforeBind?: () => Promise<void>;
  } = {},
): Harness {
  const ignore = resolveMountIgnore(options.ignore ?? ["**/node_modules", "/dist"], MOUNT);
  const dirs = new Set(options.dirs ?? []);
  const files = new Set(options.files ?? []);
  const symlinks = new Set(options.symlinks ?? []);
  const commands: string[][] = [];
  const mounted = new Set<string>();
  const warnings: string[] = [];
  const rel = (path: string) => path.slice(ROOT.length + 1);
  const inode = (path: string) => path.length;

  const seams: Partial<NativeRootsOptions> = {
    unbindRoot: async (target, rel) => {
      commands.push(["unbindRoot", target, rel]);
      mounted.delete(`${target}/${rel}`);
      return 0;
    },
    bindRoot: async (source, target, rel) => {
      commands.push(["bindRoot", source, target, rel]);
      if (options.mismatch) return -5; // Native verification failed before returning.
      if (options.mountExit) return -options.mountExit;
      await options.beforeBind?.();
      mounted.add(`${target}/${rel}`);
      return 0;
    },
    mountinfo: () =>
      [
        `22 1 0:40 / ${MOUNT} rw - fuse computerd rw`,
        ...[...mounted].map((target, i) => `${30 + i} 22 254:1 /x ${target} rw - ext4 /dev/vda rw`),
      ].join("\n"),
    lstat: (path) => {
      const key = rel(path);
      if (symlinks.has(key)) return { isDirectory: () => false, dev: 1, ino: inode(path) };
      const isDir = [...dirs, ...files].some((entry) => entry.startsWith(`${key}/`));
      if (dirs.has(key) || isDir) return { isDirectory: () => true, dev: 1, ino: inode(path) };
      if (files.has(key)) return { isDirectory: () => false, dev: 1, ino: inode(path) };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    lstatTarget: async (path) => {
      await options.beforeTarget?.();
      if (options.missingTargets?.has(path.slice(MOUNT.length + 1))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { isDirectory: () => true };
    },
    readdir: (path) => {
      const prefix = path === ROOT ? "" : `${rel(path)}/`;
      const names = new Set<string>();
      for (const entry of [...dirs, ...files, ...symlinks]) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        if (rest === "") continue;
        names.add(rest.split("/")[0] as string);
      }
      return [...names];
    },
    warn: (message) => warnings.push(message),
    openDirectory: async () => 100 + commands.length,
  };

  const roots = createNativeRoots({
    root: ROOT,
    mountPoint: MOUNT,
    ignore,
    ...(options.active ? { active: options.active } : {}),
    ...seams,
  });
  return { roots, commands, mounted, warnings };
}

describe("isRoot", () => {
  test("is a local-only directory whose parent is synced", () => {
    const { roots } = harness();
    expect(roots.isRoot("node_modules")).toBe(true);
    expect(roots.isRoot("packages/app/node_modules")).toBe(true);
    expect(roots.isRoot("/packages/app/node_modules/")).toBe(true);
  });

  test("is false below a root, for synced paths, and for the mount root", () => {
    const { roots } = harness();
    expect(roots.isRoot("node_modules/react")).toBe(false);
    expect(roots.isRoot("node_modules/react/node_modules")).toBe(false);
    expect(roots.isRoot("src")).toBe(false);
    expect(roots.isRoot("")).toBe(false);
  });

  test("is any local-only pattern's directory, not only node_modules", () => {
    const { roots } = harness();
    expect(roots.isRoot("dist")).toBe(true);
    expect(roots.isRoot("dist/assets")).toBe(false);
  });

  test("respects an exclusion that keeps a path synced", () => {
    const { roots } = harness({ ignore: ["**/node_modules", "!/vendor/node_modules"] });
    expect(roots.isRoot("vendor/node_modules")).toBe(false);
    expect(roots.isRoot("vendor/node_modules/pkg/node_modules")).toBe(true);
  });
});

describe("ensure", () => {
  test("bind-mounts the backing directory, makes it private, and verifies it", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["app/node_modules"] });
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(commands).toEqual([["bindRoot", ROOT, MOUNT, "app/node_modules"]]);
    expect([...mounted]).toEqual([`${MOUNT}/app/node_modules`]);
    expect(roots.stats()).toMatchObject({ active: 1, mounts: 1, failures: 0 });
  });

  test("ignores paths that are not native roots", async () => {
    const { roots, commands } = harness({ dirs: ["src", "dist/assets", "node_modules/react"] });
    for (const path of ["src", "dist/assets", "node_modules/react"]) roots.ensure(path);
    await roots.settled();
    expect(commands).toEqual([]);
  });

  test("never mounts over a symlink or a file", async () => {
    const { roots, commands } = harness({
      symlinks: ["a/node_modules"],
      files: ["b/node_modules"],
    });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
  });

  test("does nothing when the backing directory is already gone", async () => {
    const { roots, commands, warnings } = harness();
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("concurrent calls for one root mount once", async () => {
    const { roots, commands } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    roots.ensure("node_modules");
    roots.ensure("/node_modules/");
    await roots.settled();
    expect(commands.filter((argv) => argv[0] === "bindRoot")).toHaveLength(1);
  });

  test("an already mounted root is left alone", async () => {
    const { roots, commands } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    await roots.settled();
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands.filter((argv) => argv[0] === "bindRoot")).toHaveLength(1);
  });

  test("an unavailable native helper never falls back to a path-based mount", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["node_modules"], mountExit: 38 });
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toEqual([["bindRoot", ROOT, MOUNT, "node_modules"]]);
    expect(mounted.size).toBe(0);
    expect(roots.stats()).toMatchObject({ mounts: 0, failures: 1 });
  });

  test("a refused mount is counted and warned about once", async () => {
    const { roots, warnings } = harness({
      dirs: ["a/node_modules", "b/node_modules"],
      mountExit: 32,
    });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(roots.stats()).toMatchObject({ active: 0, mounts: 0, failures: 2 });
    expect(roots.stats().lastFailure).toContain("failed (-32)");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("serving it through FUSE instead");
  });

  test("a refused root is retried when created again, not when looked up", async () => {
    const h = harness({ dirs: ["node_modules"], mountExit: 32 });
    h.roots.ensure("node_modules", true);
    await h.roots.settled();
    h.roots.ensure("node_modules");
    h.roots.ensure("node_modules", false);
    await h.roots.settled();
    const binds = () => h.commands.filter((argv) => argv[0] === "bindRoot").length;
    expect(binds()).toBe(1);
    h.roots.ensure("node_modules", true);
    await h.roots.settled();
    expect(binds()).toBe(2);
  });

  test("a target that does not exist under the mount yet is not a failure", async () => {
    // After a restore with an in-memory store the backing directory is on
    // disk, but its synced parent is not back from the host yet.
    const missingTargets = new Set(["app/node_modules"]);
    const { roots, commands, warnings } = harness({ dirs: ["app/node_modules"], missingTargets });
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(commands).toEqual([]);
    expect(roots.stats().failures).toBe(0);
    expect(warnings).toEqual([]);
    // The first lookup once the parent is back mounts it.
    missingTargets.clear();
    roots.ensure("app/node_modules");
    await roots.settled();
    expect(roots.stats()).toMatchObject({ active: 1, mounts: 1 });
  });

  test("a native verification failure leaves no mount", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["node_modules"], mismatch: true });
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toEqual([["bindRoot", ROOT, MOUNT, "node_modules"]]);
    expect(mounted.size).toBe(0);
    expect(roots.stats()).toMatchObject({ mounts: 0, failures: 1 });
  });

  test("does nothing until switched on", async () => {
    let on = false;
    const { roots, commands } = harness({ dirs: ["node_modules"], active: () => on });
    roots.ensure("node_modules");
    roots.scan();
    await roots.settled();
    expect(commands).toEqual([]);
    on = true;
    roots.ensure("node_modules");
    await roots.settled();
    expect(commands).toHaveLength(1);
  });
});

describe("scan", () => {
  test("scan does not descend through a symlink in the backing tree", async () => {
    const { roots, commands } = harness({
      symlinks: ["q"],
      dirs: ["q/node_modules"],
    });
    roots.scan();
    await roots.settled();
    expect(commands).toEqual([]);
  });

  test("scan mounts every existing root without descending into one", async () => {
    const readdirs: string[] = [];
    const h = harness({
      dirs: [
        "node_modules/react/node_modules/x",
        "packages/a/node_modules/lodash",
        "packages/b/src",
        "dist/assets",
      ],
    });
    const roots = createNativeRoots({
      root: ROOT,
      mountPoint: MOUNT,
      ignore: resolveMountIgnore(["**/node_modules", "/dist"], MOUNT),
      bindRoot: async (source, target, rel) => {
        h.commands.push(["bindRoot", source, target, rel]);
        return 0;
      },
      mountinfo: () => "",
      lstat: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      lstatTarget: async () => ({ isDirectory: () => true }),
      readdir: (path) => {
        readdirs.push(path);
        const tree: Record<string, string[]> = {
          [ROOT]: ["node_modules", "packages", "dist"],
          [`${ROOT}/packages`]: ["a", "b"],
          [`${ROOT}/packages/a`]: ["node_modules"],
          [`${ROOT}/packages/b`]: ["src"],
          [`${ROOT}/packages/b/src`]: [],
        };
        return tree[path] ?? [];
      },
    });
    roots.scan();
    await roots.settled();
    const bound = h.commands
      .filter((argv) => argv[0] === "bindRoot")
      .map((argv) => `${MOUNT}/${argv[3]}`);
    expect(bound.sort()).toEqual([
      `${MOUNT}/dist`,
      `${MOUNT}/node_modules`,
      `${MOUNT}/packages/a/node_modules`,
    ]);
    // Never inside a root.
    expect(readdirs.some((path) => path.includes("node_modules"))).toBe(false);
    expect(readdirs.some((path) => path.includes("dist"))).toBe(false);
  });
});

describe("parking", () => {
  test("a root a caller detached is not mounted back by a lookup", async () => {
    // Otherwise `rm -rf` after a detach stats the directory, the lookup
    // mounts it again, and the rmdir gets EBUSY after all.
    const { roots, mounted } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules", true);
    await roots.settled();
    await roots.detach("node_modules");
    roots.ensure("node_modules");
    await roots.settled();
    expect(mounted.size).toBe(0);
    roots.ensure("node_modules", true);
    await roots.settled();
    expect(mounted.size).toBe(1);
  });

  test("detachAll parks nothing, so a startup scan still mounts", async () => {
    const { roots, mounted } = harness({ dirs: ["node_modules"] });
    roots.ensure("node_modules");
    await roots.settled();
    await roots.detachAll();
    roots.scan();
    await roots.settled();
    expect(mounted.size).toBe(1);
  });

  test("a mount whose target vanished on the way is not a failure", async () => {
    const missingTargets = new Set<string>();
    const h = harness({ dirs: ["node_modules"], mountExit: 32, missingTargets });
    // The target exists for the pre-check, then is gone when the mount
    // fails, as when rm -rf removes it in between.
    let checks = 0;
    const roots = createNativeRoots({
      root: ROOT,
      mountPoint: MOUNT,
      ignore: resolveMountIgnore(["**/node_modules"], MOUNT),
      bindRoot: async () => -2,
      mountinfo: () => "",
      lstat: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      lstatTarget: async () => {
        checks += 1;
        if (checks > 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isDirectory: () => true };
      },
      warn: (message) => h.warnings.push(message),
    });
    roots.ensure("node_modules");
    await roots.settled();
    expect(roots.stats().failures).toBe(0);
    expect(h.warnings).toEqual([]);
  });
});

describe("removal guard", () => {
  function fakeGuard() {
    const roots = new Map<string, number>();
    const removed: string[] = [];
    return {
      roots,
      removed,
      guard: {
        addRoot: (path: string, fd: number) => {
          roots.set(path, fd);
          return 0;
        },
        removeRoot: (path: string) => {
          removed.push(path);
          return roots.delete(path);
        },
      },
    };
  }

  test("attaching hands over roots already mounted, and later mounts follow", async () => {
    const { roots } = harness({ dirs: ["a/node_modules", "b/node_modules"] });
    roots.ensure("a/node_modules");
    await roots.settled();
    const g = fakeGuard();
    await roots.attachGuard(g.guard);
    expect([...g.roots.keys()]).toEqual([`${MOUNT}/a/node_modules`]);
    roots.ensure("b/node_modules");
    await roots.settled();
    expect([...g.roots.keys()].sort()).toEqual([
      `${MOUNT}/a/node_modules`,
      `${MOUNT}/b/node_modules`,
    ]);
  });

  test("a requested detach takes the root back from the guard", async () => {
    const { roots } = harness({ dirs: ["node_modules"] });
    const g = fakeGuard();
    await roots.attachGuard(g.guard);
    roots.ensure("node_modules");
    await roots.settled();
    await roots.detach("node_modules");
    expect(g.removed).toEqual([`${MOUNT}/node_modules`]);
    expect(g.roots.size).toBe(0);
  });

  test("a guard detach parks the root and is counted", async () => {
    const h = harness({ dirs: ["node_modules"] });
    h.roots.ensure("node_modules");
    await h.roots.settled();
    // The guard unmounted it itself, from its own thread.
    h.mounted.clear();
    h.roots.guardDetached(`${MOUNT}/node_modules`);
    expect(h.roots.stats()).toMatchObject({ detaches: 1, removalDetaches: 1, active: 0 });
    h.roots.ensure("node_modules");
    await h.roots.settled();
    expect(h.mounted.size).toBe(0);
    h.roots.ensure("node_modules", true);
    await h.roots.settled();
    expect(h.mounted.size).toBe(1);
  });

  test("a root parked while its mount was on the way is not mounted", async () => {
    // The guard detached it for an rmdir while this mount waited on the
    // thread pool; mounting now would put it back under the rmdir.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands: string[][] = [];
    const roots = createNativeRoots({
      root: ROOT,
      mountPoint: MOUNT,
      ignore: resolveMountIgnore(["**/node_modules"], MOUNT),
      bindRoot: async (source, target, rel) => {
        commands.push(["bindRoot", source, target, rel]);
        return 0;
      },
      mountinfo: () => "",
      lstat: () => ({ isDirectory: () => true, dev: 1, ino: 1 }),
      lstatTarget: async () => {
        await gate;
        return { isDirectory: () => true };
      },
    });
    roots.ensure("node_modules");
    roots.guardDetached(`${MOUNT}/node_modules`);
    release();
    await roots.settled();
    expect(commands).toEqual([]);
  });
});

describe("detach", () => {
  test("a requested detach parks a root while its target lookup is pending", async () => {
    let entered!: () => void;
    let release!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { roots, mounted, commands } = harness({
      dirs: ["node_modules"],
      beforeTarget: async () => {
        entered();
        await gate;
      },
    });
    roots.ensure("node_modules");
    await lookupStarted;
    const detaching = roots.detach("node_modules");
    release();
    expect(await detaching).toEqual([]);
    await roots.settled();
    expect(mounted.size).toBe(0);
    expect(commands).toEqual([]);
  });

  test("a requested detach waits for an in-flight bind before removing it", async () => {
    let entered!: () => void;
    let release!: () => void;
    const bindStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { roots, mounted } = harness({
      dirs: ["node_modules"],
      beforeBind: async () => {
        entered();
        await gate;
      },
    });
    roots.ensure("node_modules");
    await bindStarted;
    const detaching = roots.detach("node_modules");
    release();
    expect(await detaching).toEqual([`${MOUNT}/node_modules`]);
    expect(mounted.size).toBe(0);
  });

  test("a requested detach of all roots parks pending mounts", async () => {
    let entered!: () => void;
    let release!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { roots, mounted } = harness({
      dirs: ["node_modules"],
      beforeTarget: async () => {
        entered();
        await gate;
      },
    });
    roots.ensure("node_modules");
    await lookupStarted;
    const detaching = roots.detach();
    release();
    expect(await detaching).toEqual([]);
    roots.ensure("node_modules");
    await roots.settled();
    expect(mounted.size).toBe(0);
  });

  test("detachAll waits for in-flight binds before cleaning up", async () => {
    let entered!: () => void;
    let release!: () => void;
    const bindStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { roots, mounted } = harness({
      dirs: ["node_modules"],
      beforeBind: async () => {
        entered();
        await gate;
      },
    });
    roots.ensure("node_modules");
    await bindStarted;
    const detaching = roots.detachAll();
    release();
    expect(await detaching).toEqual([`${MOUNT}/node_modules`]);
    expect(mounted.size).toBe(0);
  });

  test("detachAll lazily detaches everything under the mount point, deepest first", async () => {
    const { roots, commands, mounted } = harness({ dirs: ["a/node_modules", "a/b/node_modules"] });
    roots.ensure("a/node_modules");
    roots.ensure("a/b/node_modules");
    await roots.settled();
    commands.length = 0;
    const detached = await roots.detachAll();
    expect(detached).toEqual([`${MOUNT}/a/b/node_modules`, `${MOUNT}/a/node_modules`]);
    expect(commands).toEqual([
      ["unbindRoot", MOUNT, "a/b/node_modules"],
      ["unbindRoot", MOUNT, "a/node_modules"],
    ]);
    expect(mounted.size).toBe(0);
    expect(roots.stats()).toMatchObject({ active: 0, detaches: 2 });
  });

  test("detach of one path leaves the others, and an unknown path is a no-op", async () => {
    const { roots, mounted } = harness({ dirs: ["a/node_modules", "b/node_modules"] });
    roots.ensure("a/node_modules");
    roots.ensure("b/node_modules");
    await roots.settled();
    expect(await roots.detach("a/node_modules")).toEqual([`${MOUNT}/a/node_modules`]);
    expect(await roots.detach("nope/node_modules")).toEqual([]);
    expect([...mounted]).toEqual([`${MOUNT}/b/node_modules`]);
  });

  test("never touches the FUSE mount itself", async () => {
    const { roots, commands } = harness();
    await roots.detachAll();
    expect(commands).toEqual([]);
  });
});

test("unescapeMountinfo decodes octal escapes", () => {
  expect(unescapeMountinfo("/workspace/my\\040app/node_modules")).toBe(
    "/workspace/my app/node_modules",
  );
  expect(unescapeMountinfo("/a\\134b")).toBe("/a\\b");
});
