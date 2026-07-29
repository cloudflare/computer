import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { createNodeVirtualFileSystem } from "../fuse/index.js";
import { mountShim } from "./index.js";

// Poll cadence for the assertions below. We pass the same value into
// the shim so the disk -> VFS reconcile fires this often, and use a
// multiple of it for wait deadlines.
const TICK_MS = 50;

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  if (lastError) throw lastError;
  throw new Error("eventually(): condition never became true");
}

async function setup() {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  onTestFinished(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  return { vfs, mountPoint, shim };
}

test("shim mirrors VFS writes onto disk", async (_ctx) => {
  const { vfs, mountPoint } = await setup();
  // VFS and host namespaces share the same absolute prefix:
  // `${mountPoint}/proj/hello.txt` is the same path in both.
  vfs.mkdirSync(`${mountPoint}/proj`, { recursive: true });
  vfs.writeFileSync(`${mountPoint}/proj/hello.txt`, Buffer.from("hello"));

  await eventually(async () => {
    const buf = await fs.readFile(path.join(mountPoint, "proj", "hello.txt"), "utf8");
    expect(buf).toBe("hello");
    return true;
  });
});

test("shim mirrors disk writes back into the VFS", async (_ctx) => {
  const { vfs, mountPoint } = await setup();
  await fs.mkdir(path.join(mountPoint, "sub"));
  await fs.writeFile(path.join(mountPoint, "sub", "note.md"), "from host");

  await eventually(() => {
    const text = vfs.readFileSync(`${mountPoint}/sub/note.md`).toString();
    expect(text).toBe("from host");
    return true;
  });
});

test("shim mirrors deletions in both directions", async (_ctx) => {
  const { vfs, mountPoint } = await setup();

  // VFS -> disk delete.
  vfs.writeFileSync(`${mountPoint}/a.txt`, Buffer.from("a"));
  await eventually(async () => {
    await fs.access(path.join(mountPoint, "a.txt"));
    return true;
  });
  vfs.unlinkSync(`${mountPoint}/a.txt`);
  await eventually(async () => {
    try {
      await fs.access(path.join(mountPoint, "a.txt"));
      return false;
    } catch {
      return true;
    }
  });

  // Disk -> VFS delete.
  await fs.writeFile(path.join(mountPoint, "b.txt"), "b");
  await eventually(() => vfs.existsSync(`${mountPoint}/b.txt`));
  await fs.rm(path.join(mountPoint, "b.txt"));
  await eventually(() => !vfs.existsSync(`${mountPoint}/b.txt`));
});

test("shim does not echo identical writes back and forth", async (_ctx) => {
  const { vfs, mountPoint } = await setup();
  const vfsPath = `${mountPoint}/stable.txt`;
  vfs.writeFileSync(vfsPath, Buffer.from("same"));

  await eventually(async () => {
    const buf = await fs.readFile(path.join(mountPoint, "stable.txt"), "utf8");
    return buf === "same";
  });

  // Touch the file on disk with identical content; the shim's
  // content-equal short-circuit should keep VFS mtime stable.
  const before = vfs.statSync(vfsPath).mtime.getTime();
  // Wait a beat so any spurious bump from an mtime-only change shows
  // up as a different value.
  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 4));
  await fs.writeFile(path.join(mountPoint, "stable.txt"), "same");
  await new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));
  const after = vfs.statSync(vfsPath).mtime.getTime();
  expect(after).toBe(before, "identical disk write should not bump VFS mtime");
});

test("shim picks up nested directory creates on disk", async (_ctx) => {
  const { vfs, mountPoint } = await setup();
  await fs.mkdir(path.join(mountPoint, "a", "b", "c"), { recursive: true });
  await fs.writeFile(path.join(mountPoint, "a", "b", "c", "leaf.txt"), "leaf");

  await eventually(() => {
    const text = vfs.readFileSync(`${mountPoint}/a/b/c/leaf.txt`).toString();
    expect(text).toBe("leaf");
    return true;
  });
});

test("shim.flush() settles VFS writes onto disk before resolving", async (_ctx) => {
  // Use a very slow poll so the watcher/poll loops can't accidentally
  // serve the assertion. If flush() works, the file is on disk before
  // any tick fires; if it doesn't, the read fails because nothing else
  // has materialised it yet.
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-flush-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: 60_000 });
  onTestFinished(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });

  vfs.mkdirSync(`${mountPoint}/proj`, { recursive: true });
  vfs.writeFileSync(`${mountPoint}/proj/a.txt`, Buffer.from("alpha"));
  vfs.writeFileSync(`${mountPoint}/proj/b.txt`, Buffer.from("beta"));

  await shim.flush();

  expect(await fs.readFile(path.join(mountPoint, "proj", "a.txt"), "utf8")).toBe("alpha");
  expect(await fs.readFile(path.join(mountPoint, "proj", "b.txt"), "utf8")).toBe("beta");
});

test("shim.flush() is idempotent and cheap on a clean tree", async (_ctx) => {
  // Second flush should be a no-op (shadow short-circuits every
  // syncVfsPathToDisk call) and complete promptly.
  const { vfs, mountPoint, shim } = await setup();
  vfs.writeFileSync(`${mountPoint}/hello.txt`, Buffer.from("world"));
  await shim.flush();
  const mtime1 = (await fs.stat(path.join(mountPoint, "hello.txt"))).mtimeMs;
  await shim.flush();
  const mtime2 = (await fs.stat(path.join(mountPoint, "hello.txt"))).mtimeMs;
  expect(mtime2).toBe(mtime1, "flush should not rewrite an unchanged file");
});

test("shim.flush() resolves on an unmounted shim without throwing", async (_ctx) => {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-flush-unmount-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  onTestFinished(async () => {
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  await shim.unmount();
  await shim.flush();
});

test("shim.reconcileNow() settles disk writes into the VFS before resolving", async (_ctx) => {
  // Mirror of the flush() test above, in the reverse direction.
  // A very slow poll guarantees the periodic reconcile can't be
  // serving the assertion; if reconcileNow() works the file is in
  // the VFS as soon as the call returns.
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-reconcile-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: 60_000 });
  onTestFinished(async () => {
    await shim.unmount();
    await fs.rm(mountPoint, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(mountPoint, "proj"), { recursive: true });
  await fs.writeFile(path.join(mountPoint, "proj", "x.txt"), "from disk");
  await fs.writeFile(path.join(mountPoint, "proj", "y.txt"), "also from disk");

  // No periodic reconcile has fired yet — the VFS is empty until
  // reconcileNow() walks the disk.
  expect(vfs.existsSync(`${mountPoint}/proj/x.txt`)).toBe(false);

  await shim.reconcileNow();

  expect(vfs.readFileSync(`${mountPoint}/proj/x.txt`).toString()).toBe("from disk");
  expect(vfs.readFileSync(`${mountPoint}/proj/y.txt`).toString()).toBe("also from disk");
});

test("shim.reconcileNow() is idempotent and cheap on a clean tree", async (_ctx) => {
  const { vfs, mountPoint, shim } = await setup();
  await fs.writeFile(path.join(mountPoint, "stable.txt"), "steady");
  await shim.reconcileNow();
  const rev1 = vfs.statSync(`${mountPoint}/stable.txt`).mtime.getTime();
  await shim.reconcileNow();
  const rev2 = vfs.statSync(`${mountPoint}/stable.txt`).mtime.getTime();
  expect(rev2).toBe(rev1, "reconcileNow on an unchanged tree should not bump VFS mtime");
});

test("shim.reconcileNow() resolves on an unmounted shim without throwing", async (_ctx) => {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-shim-reconcile-unmount-"));
  const { vfs } = await createNodeVirtualFileSystem();
  const shim = await mountShim({ vfs, mountPoint, pollIntervalMs: TICK_MS });
  onTestFinished(async () => {
    await fs.rm(mountPoint, { recursive: true, force: true });
  });
  await shim.unmount();
  await shim.reconcileNow();
});

test("shim drops VFS writes outside the mount point", async (_ctx) => {
  // Pin the cross-namespace contract that backed the original bug:
  // a write into the VFS at `${mountPoint}/foo` lands on disk at
  // the same absolute path, and a write at bare "/foo" (outside
  // the mount point) is ignored. Without this guarantee, a process
  // that `cd ${mountPoint}` sees a different file tree from the
  // RPC surface.
  const { vfs, mountPoint, shim } = await setup();
  vfs.mkdirSync(`${mountPoint}/repo`, { recursive: true });
  vfs.writeFileSync(`${mountPoint}/repo/a.txt`, Buffer.from("alpha"));
  // Sibling write outside the mount point — the shim should never
  // see this and disk should never get a stray "/repo" directory.
  vfs.writeFileSync("/outside.txt", Buffer.from("nope"));

  await shim.flush();

  expect(await fs.readFile(path.join(mountPoint, "repo", "a.txt"), "utf8")).toBe("alpha");
  await expect(fs.access(path.join(mountPoint, "outside.txt"))).rejects.toThrow(/ENOENT/);
});
