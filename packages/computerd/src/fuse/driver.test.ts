import { expect, test } from "vitest";

import { createNodeVirtualFileSystem, makeFUSEOps } from "./index.js";

const callback = (fn: (cb: (errno: number, result: unknown) => void) => void) =>
  new Promise<{ errno: number; result: unknown }>((resolve) =>
    fn((errno, result) => resolve({ errno, result })),
  );
const status = (fn: (cb: (value: number) => void) => void) =>
  new Promise<number>((resolve) => fn((value) => resolve(value)));

const fuseNativeOperationNames = [
  "init",
  "error",
  "access",
  "statfs",
  "fgetattr",
  "getattr",
  "flush",
  "fsync",
  "fsyncdir",
  "readdir",
  "truncate",
  "ftruncate",
  "utimens",
  "readlink",
  "chown",
  "chmod",
  "mknod",
  "setxattr",
  "getxattr",
  "listxattr",
  "removexattr",
  "open",
  "opendir",
  "read",
  "write",
  "release",
  "releasedir",
  "create",
  "unlink",
  "rename",
  "link",
  "symlink",
  "mkdir",
  "rmdir",
];

const notImplementedOperationNames = ["error", "mknod"];

function disableDirectWrites(vfs: unknown): void {
  const target = vfs as {
    createFileSync?: unknown;
    writeRangeSync?: unknown;
    truncateFileSync?: unknown;
  };
  delete target.createFileSync;
  delete target.writeRangeSync;
  delete target.truncateFileSync;
}

test("FUSE ops expose the complete fuse-native operation surface", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);

  for (const name of fuseNativeOperationNames) {
    expect(typeof ops[name]).toBe("function", `${name} should be defined`);
  }
});

test("not-yet-implemented FUSE ops invoke their callback with ENOSYS", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);
  const ENOSYS = -38;

  for (const name of notImplementedOperationNames) {
    if (name === "error") continue; // error has no callback arg
    const errno = await new Promise<number>((resolve) => {
      // Call with a single argument: the callback.
      (ops as Record<string, (...args: unknown[]) => void>)[name](resolve);
    });
    expect(errno).toBe(ENOSYS, `${name} should return ENOSYS`);
  }
});

test("implemented FUSE ops all have explicit current expectations", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  expect(await status((cb) => ops.init(cb))).toBe(0);

  expect(await status((cb) => ops.mkdir("/dir", 0o755, cb))).toBe(0);
  expect(await status((cb) => ops.access("/dir", 0, cb))).toBe(0);
  expect(await status((cb) => ops.access("/missing", 0, cb))).toBe(-2);

  const rootDir = await callback((cb) => ops.opendir("/", 0, cb));
  expect(rootDir.errno).toBe(0);
  expect(typeof rootDir.result).toBe("number");
  expect(await status((cb) => ops.releasedir("/", rootDir.result as number, cb))).toBe(0);

  const create = await callback((cb) => ops.create("/dir/file.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  expect(typeof create.result).toBe("number");

  const open = await callback((cb) => ops.open("/dir/file.txt", 0, cb));
  expect(open.errno).toBe(0);
  expect(typeof open.result).toBe("number");

  const bytes = Buffer.from("hello fuse");
  expect(
    await status((cb) =>
      ops.write("/dir/file.txt", create.result as number, bytes, bytes.length, 0, cb),
    ),
  ).toBe(bytes.length);

  const readBuffer = Buffer.alloc(bytes.length);
  expect(
    await status((cb) =>
      ops.read("/dir/file.txt", create.result as number, readBuffer, readBuffer.length, 0, cb),
    ),
  ).toBe(bytes.length);
  expect(readBuffer.toString()).toBe("hello fuse");

  const dir = await callback((cb) => ops.readdir("/dir", cb));
  expect(dir.errno).toBe(0);
  expect(dir.result).toEqual(["file.txt"]);

  const stat = await callback((cb) => ops.getattr("/dir/file.txt", cb));
  expect(stat.errno).toBe(0);
  expect((stat.result as { size: number }).size).toBe(bytes.length);

  const fstat = await callback((cb) => ops.fgetattr("/dir/file.txt", create.result as number, cb));
  expect(fstat.errno).toBe(0);
  expect((fstat.result as { size: number }).size).toBe(bytes.length);

  const statfs = await callback((cb) => ops.statfs("/", cb));
  expect(statfs.errno).toBe(0);
  expect((statfs.result as { bsize: number; namemax: number }).bsize).toBe(4096);
  expect((statfs.result as { bsize: number; namemax: number }).namemax).toBe(255);

  expect(await status((cb) => ops.chmod("/dir/file.txt", 0o600, cb))).toBe(0);
  expect(await status((cb) => ops.chown("/dir/file.txt", 123, 456, cb))).toBe(0);
  expect(await status((cb) => ops.flush("/dir/file.txt", create.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/dir/file.txt", create.result as number, 0, cb))).toBe(0);
  expect(await status((cb) => ops.fsyncdir("/dir", rootDir.result as number, 0, cb))).toBe(0);

  expect(
    await status((cb) =>
      ops.setxattr("/dir/file.txt", "user.test", Buffer.from("value"), 0, 0, cb),
    ),
  ).toBe(0);
  expect(await status((cb) => ops.getxattr("/dir/file.txt", "user.test", 0, cb))).toBe(-61);
  const xattrs = await callback((cb) => ops.listxattr("/dir/file.txt", cb));
  expect(xattrs.errno).toBe(0);
  expect(Buffer.isBuffer(xattrs.result)).toBe(true);
  expect((xattrs.result as Buffer).length).toBe(0);
  expect(await status((cb) => ops.removexattr("/dir/file.txt", "user.test", cb))).toBe(-61);
  expect(await status((cb) => ops.utimens("/dir/file.txt", Date.now(), Date.now(), cb))).toBe(0);
  expect(await status((cb) => ops.utimens("/missing", Date.now(), Date.now(), cb))).toBe(-2);

  expect(await status((cb) => ops.rename("/dir/file.txt", "/dir/renamed.txt", cb))).toBe(0);
  const renamedBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, renamedBuf, renamedBuf.length, 0, cb)),
  ).toBe(bytes.length);
  expect(renamedBuf.subarray(0, bytes.length).toString()).toBe("hello fuse");

  expect(await status((cb) => ops.truncate("/dir/renamed.txt", 5, cb))).toBe(0);
  const truncBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, truncBuf, truncBuf.length, 0, cb)),
  ).toBe(5);
  expect(truncBuf.subarray(0, 5).toString()).toBe("hello");

  expect(
    await status((cb) => ops.ftruncate("/dir/renamed.txt", create.result as number, 2, cb)),
  ).toBe(0);
  const ftruncBuf = Buffer.alloc(64);
  expect(
    await status((cb) => ops.read("/dir/renamed.txt", 0, ftruncBuf, ftruncBuf.length, 0, cb)),
  ).toBe(2);
  expect(ftruncBuf.subarray(0, 2).toString()).toBe("he");

  expect(await status((cb) => ops.release("/dir/renamed.txt", create.result as number, cb))).toBe(
    0,
  );
  expect(await status((cb) => ops.release("/dir/renamed.txt", open.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.unlink("/dir/renamed.txt", cb))).toBe(0);
  expect(vfs.readdirSync("/dir")).toEqual([]);
  expect(await status((cb) => ops.rmdir("/dir", cb))).toBe(0);
  expect(vfs.readdirSync("/")).toEqual([]);
});

test("FUSE ops return errno values instead of throwing for expected filesystem errors", async () => {
  const ops = makeFUSEOps((await createNodeVirtualFileSystem()).vfs);

  const missing = await callback((cb) => ops.getattr("/missing", cb));
  expect(missing.errno).toBe(-2);

  expect(await status((cb) => ops.open("/missing", 0, cb))).toBe(-2);
  expect(await status((cb) => ops.unlink("/missing", cb))).toBe(-2);
});

test("FUSE maps read-only provider mutations to EROFS", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/readonly.txt", Buffer.from("content"));
  const throwReadOnly = () => {
    throw Object.assign(new Error("read-only mount"), { code: "EROFS" });
  };
  const readOnlyVfs = Object.assign(vfs, {
    createFileSync: () => undefined,
    writeRangeSync: throwReadOnly,
    truncateFileSync: throwReadOnly,
    openWriteBufferSync: () => undefined,
    releaseWriteBufferSync: throwReadOnly,
  });
  const ops = makeFUSEOps(readOnlyVfs);

  const opened = await callback((cb) => ops.open("/readonly.txt", 0, cb));
  expect(opened.errno).toBe(0);
  const fh = opened.result as number;
  expect(await status((cb) => ops.write("/readonly.txt", fh, Buffer.from("x"), 1, 0, cb))).toBe(
    -30,
  );
  expect(await status((cb) => ops.truncate("/readonly.txt", 0, cb))).toBe(-30);
  expect(await status((cb) => ops.release("/readonly.txt", fh, cb))).toBe(-30);
});

test("FUSE unlink removes a symlink itself rather than its target", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  vfs.writeFileSync("/target.txt", Buffer.from("still here"));
  expect(await status((cb) => ops.symlink("/target.txt", "/link.txt", cb))).toBe(0);

  expect(await status((cb) => ops.unlink("/link.txt", cb))).toBe(0);

  expect(() => vfs.lstatSync("/link.txt")).toThrow();
  expect(Buffer.from(vfs.readFileSync("/target.txt")).toString("utf8")).toBe("still here");
});

test("write past the per-file cap returns EFBIG instead of growing unbounded", async () => {
  // The driver keeps an in-memory buffer per file and doubles its
  // capacity on demand. Without a ceiling, a runaway client can OOM
  // the daemon. We cap per-file size at 256 MiB and surface EFBIG.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/big", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  // Sized just past the cap. The driver allocates the buffer up-front
  // and writes into it, so this also catches an off-by-one in the
  // boundary check.
  const PAST_CAP = 256 * 1024 * 1024 + 1;
  const tinyBuffer = Buffer.alloc(1, 0x61);
  const written = await status((cb: (value: number) => void) =>
    ops.write("/big", fh, tinyBuffer, 1, PAST_CAP - 1, cb),
  );
  expect(written).toBe(-27, "expected EFBIG (-27)");

  // Truncate past the cap should also refuse rather than allocate.
  const truncated = await status((cb: (value: number) => void) =>
    ops.truncate("/big", PAST_CAP, cb),
  );
  expect(truncated).toBe(-27, "expected EFBIG (-27) from truncate");
});

test("FUSE write is visible through the backing VFS after release", async () => {
  // The production container example showed FUSE-written files
  // returning HTTP 200 / 0 bytes when read back via the RPC
  // surface. makeFUSEOps keeps a per-file in-memory buffer
  // (`files` Map) that .write() updates; .release(), .flush(),
  // and .fsync() spill that buffer into the backing VFS so
  // anything reading through the VFS surface (capnweb pull,
  // host-side @platformatic/vfs consumers) sees the bytes.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/from-fuse.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  const payload = Buffer.from("from-fuse\n", "utf8");
  const written = await status((cb: (value: number) => void) =>
    ops.write("/from-fuse.txt", fh, payload, payload.byteLength, 0, cb),
  );
  expect(written).toBe(payload.byteLength);

  // release + flush + fsync — every codepath a well-behaved
  // client would call before considering the write durable.
  expect(await status((cb) => ops.flush("/from-fuse.txt", fh, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/from-fuse.txt", fh, 0, cb))).toBe(0);
  expect(await status((cb) => ops.release("/from-fuse.txt", fh, cb))).toBe(0);

  // The VFS is the RPC surface's source of truth. Anything that
  // wasn't written here doesn't survive a pullOnce.
  const fromVfs = vfs.readFileSync("/from-fuse.txt");
  expect(Buffer.from(fromVfs).toString("utf8")).toBe(
    "from-fuse\n",
    "FUSE writes must be flushed into the backing VFS for RPC reads to see them",
  );
});

test("FUSE truncate is visible through the backing VFS after fsync", async () => {
  // truncate writes only to the in-memory buffer (entry.size,
  // zero-fill via entry.buf). Without an explicit spill the VFS
  // still reports the pre-truncate size, breaking sync-side stat.
  // Pin the contract: after truncate + fsync, vfs.statSync reports
  // the truncated size and vfs.readFileSync returns the truncated
  // bytes.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  // Seed a file with content.
  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/t.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("original-content", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/t.txt", fh, payload, payload.byteLength, 0, cb),
  );
  expect(await status((cb) => ops.fsync("/t.txt", fh, 0, cb))).toBe(0);
  expect(vfs.statSync("/t.txt").size).toBe(payload.byteLength);

  // Shrink via truncate and re-sync.
  expect(await status((cb) => ops.truncate("/t.txt", 5, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/t.txt", fh, 0, cb))).toBe(0);

  expect(vfs.statSync("/t.txt").size).toBe(5);
  expect(Buffer.from(vfs.readFileSync("/t.txt")).toString("utf8")).toBe("origi");
});

test("FUSE rename carries the buffered bytes to the new path", async () => {
  // rename() moves the entry in the `files` Map alongside the VFS
  // rename. If only the VFS rename ran, a buffered-but-unflushed
  // write would land on the old path's empty inode (now ENOENT)
  // and the new path would read empty.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/old.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("renamed-content", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/old.txt", fh, payload, payload.byteLength, 0, cb),
  );

  // Rename before the buffer ever spills. The buffer entry moves
  // with the file; fsync on the new path spills correctly.
  expect(await status((cb) => ops.rename("/old.txt", "/new.txt", cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/new.txt", fh, 0, cb))).toBe(0);

  expect(Buffer.from(vfs.readFileSync("/new.txt")).toString("utf8")).toBe("renamed-content");
  // Old path is gone from both layers.
  expect(() => vfs.statSync("/old.txt")).toThrow();
});

test("FUSE getattr size matches what readFileSync would return", async () => {
  // Direct writes update the backing VFS immediately, so getattr and
  // provider stat agree before fsync/release. The old buffered fallback
  // used to expose a deferred-create window here.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/g.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("twelve-bytes", "utf8");
  await status((cb: (value: number) => void) =>
    ops.write("/g.txt", fh, payload, payload.byteLength, 0, cb),
  );
  // Direct-write state: FUSE getattr and backing VFS stat agree before a
  // flushing op.
  const beforeFlush = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/g.txt", cb),
  );
  expect((beforeFlush.result as { size: number }).size).toBe(12);
  expect(vfs.statSync("/g.txt").size).toBe(12);

  // After flush they still agree — anything calling stat through
  // the VFS (RPC, host-side platformatic/vfs) needs the truth.
  expect(await status((cb) => ops.fsync("/g.txt", fh, 0, cb))).toBe(0);
  const afterFlush = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/g.txt", cb),
  );
  expect((afterFlush.result as { size: number }).size).toBe(12);
  expect(vfs.statSync("/g.txt").size).toBe(12);
});

test("FUSE ops translate kernel-relative paths onto the configured mount point", async () => {
  // The kernel hands the driver paths relative to the mount root
  // (e.g. "/repo/a.txt"). With mountPoint="/workspace" each path
  // resolves under /workspace/... in the backing VFS, so capnweb
  // pulls and shell `exec` consumers see the same absolute path.
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.mkdirSync("/workspace/repo", { recursive: true });
  vfs.writeFileSync("/workspace/repo/a.txt", Buffer.from("alpha"));
  const ops = makeFUSEOps(vfs, "/workspace");

  const dir = await callback((cb) => ops.readdir("/repo", cb));
  expect(dir.errno).toBe(0);
  expect(dir.result).toEqual(["a.txt"]);

  const open = await callback((cb) => ops.open("/repo/a.txt", 0, cb));
  expect(open.errno).toBe(0);
  const readBuffer = Buffer.alloc(5);
  expect(
    await status((cb) => ops.read("/repo/a.txt", open.result as number, readBuffer, 5, 0, cb)),
  ).toBe(5);
  expect(readBuffer.toString()).toBe("alpha");

  const create = await callback((cb) => ops.create("/repo/b.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  const payload = Buffer.from("bravo");
  expect(
    await status((cb) =>
      ops.write("/repo/b.txt", create.result as number, payload, payload.length, 0, cb),
    ),
  ).toBe(payload.length);
  expect(await status((cb) => ops.release("/repo/b.txt", create.result as number, cb))).toBe(0);

  expect(vfs.readFileSync("/workspace/repo/b.txt").toString()).toBe("bravo");
  // The unprefixed path doesn't exist in the VFS — it would only
  // exist if the driver had skipped the mountPoint translation.
  expect(vfs.existsSync("/repo/b.txt")).toBe(false);
});

test("FUSE clean buffers are not spilled repeatedly", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  disableDirectWrites(vfs);
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/clean-after-flush.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  let writesAfterCreate = 0;
  const writeFileSync = vfs.writeFileSync.bind(vfs);
  vfs.writeFileSync = (...args: Parameters<typeof vfs.writeFileSync>) => {
    writesAfterCreate += 1;
    return writeFileSync(...args);
  };

  const payload = Buffer.from("spill-once", "utf8");
  expect(
    await status((cb) =>
      ops.write("/clean-after-flush.txt", fh, payload, payload.byteLength, 0, cb),
    ),
  ).toBe(payload.byteLength);

  expect(await status((cb) => ops.flush("/clean-after-flush.txt", fh, cb))).toBe(0);
  expect(await status((cb) => ops.fsync("/clean-after-flush.txt", fh, 0, cb))).toBe(0);
  expect(await status((cb) => ops.release("/clean-after-flush.txt", fh, cb))).toBe(0);

  expect(writesAfterCreate).toBe(1);
  expect(Buffer.from(vfs.readFileSync("/clean-after-flush.txt")).toString("utf8")).toBe(
    "spill-once",
  );
});

test("FUSE read-only hydrated buffers are not spilled on close", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/read-only.txt", Buffer.from("existing", "utf8"));
  const ops = makeFUSEOps(vfs);

  let writesAfterSeed = 0;
  const writeFileSync = vfs.writeFileSync.bind(vfs);
  vfs.writeFileSync = (...args: Parameters<typeof vfs.writeFileSync>) => {
    writesAfterSeed += 1;
    return writeFileSync(...args);
  };

  const open = await callback((cb) => ops.open("/read-only.txt", 0, cb));
  expect(open.errno).toBe(0);
  const fh = open.result as number;
  const buf = Buffer.alloc(8);
  expect(await status((cb) => ops.read("/read-only.txt", fh, buf, buf.byteLength, 0, cb))).toBe(8);
  expect(buf.toString()).toBe("existing");

  expect(await status((cb) => ops.flush("/read-only.txt", fh, cb))).toBe(0);
  expect(await status((cb) => ops.release("/read-only.txt", fh, cb))).toBe(0);
  expect(writesAfterSeed).toBe(0);
});

test("FUSE flush uses ranged writes when the backing VFS supports them", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  disableDirectWrites(vfs);
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/ranged.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  const rangedCalls: Array<{
    path: string;
    data: Buffer;
    ranges: Array<{ start: number; end: number }>;
  }> = [];
  const writeFileSync = vfs.writeFileSync.bind(vfs);
  (
    vfs as typeof vfs & {
      writeFileRangesSync: (
        path: string,
        data: Buffer,
        ranges: Array<{ start: number; end: number }>,
      ) => void;
    }
  ).writeFileRangesSync = (path, data, ranges) => {
    rangedCalls.push({
      path,
      data: Buffer.from(data),
      ranges: ranges.map((range) => ({ ...range })),
    });
    writeFileSync(path, data);
  };

  expect(
    await status((cb) => ops.write("/ranged.txt", fh, Buffer.from("hello"), "hello".length, 0, cb)),
  ).toBe("hello".length);
  expect(await status((cb) => ops.flush("/ranged.txt", fh, cb))).toBe(0);

  expect(rangedCalls).toHaveLength(1);
  expect(rangedCalls[0]).toMatchObject({ path: "/ranged.txt", ranges: [{ start: 0, end: 5 }] });
  expect(rangedCalls[0].data.toString("utf8")).toBe("hello");
});

test("FUSE partial writes preserve existing content", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/partial.txt", Buffer.from("abcde", "utf8"));
  const ops = makeFUSEOps(vfs);

  const open = await callback((cb) => ops.open("/partial.txt", 0, cb));
  expect(open.errno).toBe(0);
  expect(
    await status((cb) =>
      ops.write("/partial.txt", open.result as number, Buffer.from("X"), 1, 2, cb),
    ),
  ).toBe(1);
  expect(await status((cb) => ops.flush("/partial.txt", open.result as number, cb))).toBe(0);
  expect(Buffer.from(vfs.readFileSync("/partial.txt")).toString("utf8")).toBe("abXde");
});

test("FUSE ops reject a relative mountPoint", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  expect(() => makeFUSEOps(vfs, "workspace")).toThrow(/absolute/);
});

test("FUSE direct reads do not force later writes onto the buffered fallback", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/direct-read-write.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const first = Buffer.from("first");
  expect(
    await status((cb) => ops.write("/direct-read-write.txt", fh, first, first.byteLength, 0, cb)),
  ).toBe(first.byteLength);

  const out = Buffer.alloc(first.byteLength);
  expect(
    await status((cb) => ops.read("/direct-read-write.txt", fh, out, out.byteLength, 0, cb)),
  ).toBe(first.byteLength);
  expect(out.toString()).toBe("first");
  expect(ops.getBufferStats()).toMatchObject({ entries: 0, dirtyEntries: 0, capacityBytes: 0 });

  const second = Buffer.from("second");
  expect(
    await status((cb) => ops.write("/direct-read-write.txt", fh, second, second.byteLength, 0, cb)),
  ).toBe(second.byteLength);
  expect(vfs.readFileSync("/direct-read-write.txt").toString()).toBe("second");
  expect(ops.getBufferStats()).toMatchObject({ entries: 0, dirtyEntries: 0, capacityBytes: 0 });
});

test("FUSE direct reads use readRangeSync instead of materializing the whole file", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/range.bin", Buffer.from("hello world"));

  let readFileCalls = 0;
  const realReadFileSync = vfs.readFileSync.bind(vfs);
  vfs.readFileSync = (...args: Parameters<typeof vfs.readFileSync>) => {
    readFileCalls += 1;
    return realReadFileSync(...args);
  };
  let rangeCalls = 0;
  const rangeAware = vfs as typeof vfs & {
    readRangeSync: (path: string, offset: number, length: number) => Buffer;
  };
  const realReadRangeSync = rangeAware.readRangeSync.bind(rangeAware);
  rangeAware.readRangeSync = (path: string, offset: number, length: number) => {
    rangeCalls += 1;
    return realReadRangeSync(path, offset, length);
  };

  const ops = makeFUSEOps(vfs);
  const open = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.open("/range.bin", 0, cb),
  );
  expect(open.errno).toBe(0);
  const fh = open.result as number;

  const buf = Buffer.alloc(5);
  expect(await status((cb) => ops.read("/range.bin", fh, buf, buf.byteLength, 6, cb))).toBe(5);
  expect(buf.toString()).toBe("world");
  expect(rangeCalls).toBe(1);
  expect(readFileCalls).toBe(0);

  expect(await status((cb) => ops.release("/range.bin", fh, cb))).toBe(0);
});

test("FUSE direct writes are visible through the VFS before release", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/direct.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("direct");
  expect(
    await status((cb) => ops.write("/direct.txt", fh, payload, payload.byteLength, 0, cb)),
  ).toBe(payload.byteLength);

  expect(vfs.readFileSync("/direct.txt").toString()).toBe("direct");
  expect(ops.getBufferStats()).toMatchObject({ entries: 0, dirtyEntries: 0, capacityBytes: 0 });

  expect(await status((cb) => ops.release("/direct.txt", fh, cb))).toBe(0);
});

test("FUSE buffer stats report resident write buffers", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  disableDirectWrites(vfs);
  const ops = makeFUSEOps(vfs);

  expect(ops.getBufferStats()).toMatchObject({
    entries: 0,
    dirtyEntries: 0,
    capacityBytes: 0,
    logicalBytes: 0,
  });

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/stats.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("tracked");
  expect(
    await status((cb) => ops.write("/stats.txt", fh, payload, payload.byteLength, 0, cb)),
  ).toBe(payload.byteLength);

  expect(ops.getBufferStats()).toMatchObject({
    entries: 1,
    dirtyEntries: 1,
    pendingCreates: 1,
    logicalBytes: payload.byteLength,
    dirtyLogicalBytes: payload.byteLength,
    openPaths: 1,
  });
  expect(ops.getBufferStats().capacityBytes).toBeGreaterThanOrEqual(payload.byteLength);

  expect(await status((cb) => ops.release("/stats.txt", fh, cb))).toBe(0);
  expect(ops.getBufferStats()).toMatchObject({
    entries: 0,
    dirtyEntries: 0,
    capacityBytes: 0,
    logicalBytes: 0,
    openPaths: 0,
  });
});

test("FUSE release evicts clean file buffers after flush", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/evict.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const first = Buffer.from("first");
  expect(await status((cb) => ops.write("/evict.txt", fh, first, first.byteLength, 0, cb))).toBe(
    first.byteLength,
  );
  expect(await status((cb) => ops.flush("/evict.txt", fh, cb))).toBe(0);
  expect(await status((cb) => ops.release("/evict.txt", fh, cb))).toBe(0);

  vfs.writeFileSync("/evict.txt", Buffer.from("second"));
  const open = await callback((cb) => ops.open("/evict.txt", 0, cb));
  expect(open.errno).toBe(0);
  const out = Buffer.alloc("second".length);
  expect(
    await status((cb) => ops.read("/evict.txt", open.result as number, out, out.byteLength, 0, cb)),
  ).toBe(out.byteLength);
  expect(out.toString()).toBe("second");
});

test("FUSE getattr reflects mtime and size after an external VFS write", async () => {
  // The auto_cache FUSE option asks the kernel to invalidate its
  // page cache for a file when the file's mtime or size changes
  // between opens. That is the lever for the sync-on-the-host
  // workflow: a remote push lands new bytes in the VFS, the
  // container reopens the file, the kernel notices the metadata
  // change and re-reads instead of serving stale page-cache
  // bytes. The contract the kernel relies on is that the FUSE
  // driver's getattr surfaces the new mtime and size promptly.
  // This test pins that contract so a future driver change
  // doesn't quietly mask the metadata signal and break the
  // safety story for auto_cache.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  vfs.writeFileSync("/sync.txt", Buffer.from("first"));
  const initial = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/sync.txt", cb),
  );
  expect(initial.errno).toBe(0);
  const initialStat = initial.result as { size: number; mtime: Date };
  expect(initialStat.size).toBe(5);

  // Simulate a sync-side mutation: bytes change, length changes,
  // and (because the VFS uses a clock-driven mtime) mtime
  // changes. Wait a few ms so the clock has room to tick.
  await new Promise((resolve) => setTimeout(resolve, 5));
  vfs.writeFileSync("/sync.txt", Buffer.from("second payload"));

  const after = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/sync.txt", cb),
  );
  expect(after.errno).toBe(0);
  const afterStat = after.result as { size: number; mtime: Date };
  expect(afterStat.size).toBe(14);
  expect(afterStat.mtime.getTime()).toBeGreaterThan(initialStat.mtime.getTime());
});

test("FUSE buffered writes surface a fresh size through getattr before flush", async () => {
  // Companion to the auto_cache contract test above. With
  // auto_cache the kernel only invalidates when mtime or size
  // changes; if the driver's in-memory buffer were to mask a
  // size growth from getattr, the kernel would keep serving
  // stale page-cache bytes after a local write. Lock the
  // buffered-getattr behavior so a future buffer refactor can't
  // regress it.
  //
  // The deferred-create path means the VFS has no inode at all
  // before flush, so this test inspects only the FUSE-side
  // getattr result; the matching VFS-side assertion lives in
  // "FUSE getattr size matches what readFileSync would return".
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/buf.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("buffered");
  await status((cb: (value: number) => void) =>
    ops.write("/buf.txt", fh, payload, payload.byteLength, 0, cb),
  );

  const stat = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/buf.txt", cb),
  );
  expect((stat.result as { size: number }).size).toBe(payload.byteLength);
});

test("FUSE mode survives a flush after chmod on a pre-existing file", async () => {
  // Regression: flushEntry used to call vfs.writeFileSync without a
  // mode, so writeFileSync's `mode ?? 0o644` default would silently
  // overwrite the persisted mode on every spill. The FUSE-side
  // getattr still saw the right mode (via the meta override) but RPC
  // consumers reading through the VFS saw 0o644. Pin the persisted
  // mode through a chmod + write + flush cycle.
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/mode.txt", Buffer.from("a"), { mode: 0o755 });
  const ops = makeFUSEOps(vfs);

  expect(await status((cb) => ops.chmod("/mode.txt", 0o600, cb))).toBe(0);

  const open = await callback((cb) => ops.open("/mode.txt", 0, cb));
  expect(open.errno).toBe(0);
  const fh = open.result as number;
  await status((cb) => ops.write("/mode.txt", fh, Buffer.from("b"), 1, 0, cb));
  expect(await status((cb) => ops.flush("/mode.txt", fh, cb))).toBe(0);

  expect(vfs.statSync("/mode.txt").mode & 0o7777).toBe(0o600);
});

test("FUSE create+chmod+flush persists the chmod'd mode in the VFS", async () => {
  // Companion to the test above for the deferred-create path: a
  // chmod before the first flush must still reach the VFS write.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/new.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  await status((cb) => ops.write("/new.txt", fh, Buffer.from("x"), 1, 0, cb));
  expect(await status((cb) => ops.chmod("/new.txt", 0o600, cb))).toBe(0);
  expect(await status((cb) => ops.flush("/new.txt", fh, cb))).toBe(0);

  expect(vfs.statSync("/new.txt").mode & 0o7777).toBe(0o600);
});

test("FUSE link creates a second name for the same file inode", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/a.txt", Buffer.from("hi"));
  const ops = makeFUSEOps(vfs);

  expect(await status((cb) => ops.link("/a.txt", "/b.txt", cb))).toBe(0);

  const a = await callback((cb) => ops.getattr("/a.txt", cb));
  const b = await callback((cb) => ops.getattr("/b.txt", cb));
  expect(a.errno).toBe(0);
  expect(b.errno).toBe(0);
  expect((a.result as { nlink: number; ino: number }).nlink).toBe(2);
  expect((b.result as { nlink: number; ino: number }).nlink).toBe(2);
  expect((a.result as { nlink: number; ino: number }).ino).toBe(
    (b.result as { nlink: number; ino: number }).ino,
  );

  const open = await callback((cb) => ops.open("/b.txt", 0, cb));
  expect(open.errno).toBe(0);
  const payload = Buffer.from("bye");
  expect(
    await status((cb) =>
      ops.write("/b.txt", open.result as number, payload, payload.byteLength, 0, cb),
    ),
  ).toBe(payload.byteLength);
  expect(await status((cb) => ops.flush("/b.txt", open.result as number, cb))).toBe(0);

  expect(Buffer.from(vfs.readFileSync("/a.txt")).toString("utf8")).toBe("bye");
});

test("FUSE link flushes a pending-create source before linking", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/src.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  const payload = Buffer.from("linked");
  await status((cb) => ops.write("/src.txt", fh, payload, payload.byteLength, 0, cb));

  expect(await status((cb) => ops.link("/src.txt", "/dst.txt", cb))).toBe(0);
  expect(Buffer.from(vfs.readFileSync("/dst.txt")).toString("utf8")).toBe("linked");
  expect(vfs.statSync("/src.txt").ino).toBe(vfs.statSync("/dst.txt").ino);
  expect(vfs.statSync("/src.txt").nlink).toBe(2);
});

test("FUSE link surfaces POSIX errors", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/a.txt", Buffer.from("hi"));
  const ops = makeFUSEOps(vfs);

  expect(await status((cb) => ops.link("/missing.txt", "/b.txt", cb))).toBe(-2);
  expect(await status((cb) => ops.link("/a.txt", "/a.txt", cb))).toBe(-17);
});

test("FUSE rename of a pending-create file overwrites an existing destination", async () => {
  // Regression: the pending-create branch in rename returned
  // EEXIST when the destination existed. POSIX rename(2) allows
  // overwriting a regular file at the destination, and the non-
  // pending-create branch already does. The driver-internal
  // create-not-yet-flushed window shouldn't be visible to callers.
  const { vfs } = await createNodeVirtualFileSystem();
  vfs.writeFileSync("/dst.txt", Buffer.from("old"));
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/src.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;
  await status((cb) => ops.write("/src.txt", fh, Buffer.from("new"), 3, 0, cb));

  expect(await status((cb) => ops.rename("/src.txt", "/dst.txt", cb))).toBe(0);
  expect(await status((cb) => ops.flush("/dst.txt", fh, cb))).toBe(0);

  expect(Buffer.from(vfs.readFileSync("/dst.txt")).toString("utf8")).toBe("new");
});

test("FUSE getattr on a pending-create file returns a stable mtime", async () => {
  // Regression: pendingStat returned `new Date()` every call, so two
  // consecutive stats of an unchanged inode reported different
  // mtimes. With auto_cache on, an advancing mtime forces the kernel
  // to invalidate the page cache on every open for the lifetime of
  // the pending-create window. Pin the stable contract.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/stable.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);

  const first = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/stable.txt", cb),
  );
  expect(first.errno).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.getattr("/stable.txt", cb),
  );
  expect(second.errno).toBe(0);

  expect((second.result as { mtime: Date }).mtime.getTime()).toBe(
    (first.result as { mtime: Date }).mtime.getTime(),
  );
});

test("FUSE getattr reports st_blocks so du sees non-zero usage", async () => {
  // Regression: getattr omitted `blocks`/`blksize`, so the kernel
  // reported st_blocks=0 for every inode and `du`, which reads
  // st_blocks rather than st_size, reported zero usage across the
  // whole mount. POSIX st_blocks counts 512-byte units; a 513-byte
  // file occupies two of them.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb) => ops.create("/du.txt", 0o644, cb));
  expect(create.errno).toBe(0);

  const payload = Buffer.alloc(513, 0x61);
  expect(
    await status((cb) =>
      ops.write("/du.txt", create.result as number, payload, payload.length, 0, cb),
    ),
  ).toBe(payload.length);
  expect(await status((cb) => ops.flush("/du.txt", create.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.release("/du.txt", create.result as number, cb))).toBe(0);

  const stat = await callback((cb) => ops.getattr("/du.txt", cb));
  expect(stat.errno).toBe(0);
  expect(stat.result).toMatchObject({ size: 513, blksize: 4096, blocks: 2 });
});

test("FUSE getattr reports zero blocks for an empty file", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb) => ops.create("/empty.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  expect(await status((cb) => ops.flush("/empty.txt", create.result as number, cb))).toBe(0);
  expect(await status((cb) => ops.release("/empty.txt", create.result as number, cb))).toBe(0);

  const stat = await callback((cb) => ops.getattr("/empty.txt", cb));
  expect(stat.errno).toBe(0);
  expect(stat.result).toMatchObject({ size: 0, blksize: 4096, blocks: 0 });
});

test("FUSE getattr on a pending-create file reports block metadata", async () => {
  // The pending-create window stats out of the in-memory buffer, not
  // the VFS. Its block accounting must match the buffered size so a
  // `du` before the first flush still sees the bytes.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb) => ops.create("/pending.txt", 0o644, cb));
  expect(create.errno).toBe(0);

  const payload = Buffer.alloc(1025, 0x62);
  expect(
    await status((cb) =>
      ops.write("/pending.txt", create.result as number, payload, payload.length, 0, cb),
    ),
  ).toBe(payload.length);

  const stat = await callback((cb) => ops.getattr("/pending.txt", cb));
  expect(stat.errno).toBe(0);
  expect(stat.result).toMatchObject({ size: 1025, blksize: 4096, blocks: 3 });
});

test("FUSE getattr block count tracks buffered size before flush", async () => {
  // With buffered writes the VFS inode still holds the old size while
  // the FileEntry carries the fresh bytes. getattr overrides size
  // with the buffered value; blocks must follow so a `du` before the
  // spill matches the size the kernel sees.
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb) => ops.create("/buf-blocks.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  const seed = Buffer.from("seed");
  expect(
    await status((cb) =>
      ops.write("/buf-blocks.txt", create.result as number, seed, seed.length, 0, cb),
    ),
  ).toBe(seed.length);
  expect(await status((cb) => ops.flush("/buf-blocks.txt", create.result as number, cb))).toBe(0);

  // Grow the buffer past a block boundary without flushing.
  const grow = Buffer.alloc(2000, 0x63);
  expect(
    await status((cb) =>
      ops.write("/buf-blocks.txt", create.result as number, grow, grow.length, 0, cb),
    ),
  ).toBe(grow.length);

  const stat = await callback((cb) => ops.getattr("/buf-blocks.txt", cb));
  expect(stat.errno).toBe(0);
  expect(stat.result).toMatchObject({ size: 2000, blksize: 4096, blocks: 4 });
});

test("xattr: getxattr for a VFS-backed file returns correct codes", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  // Create and flush a VFS-backed file.
  const create = await callback((cb) => ops.create("/xattr-backed.txt", 0o644, cb));
  expect(create.errno).toBe(0);
  await status((cb) => ops.flush("/xattr-backed.txt", create.result as number, cb));
  await status((cb) => ops.release("/xattr-backed.txt", create.result as number, cb));

  // getxattr returns ENODATA (the file exists but has no xattrs).
  expect(await status((cb) => ops.getxattr("/xattr-backed.txt", "user.x", 0, cb))).toBe(-61);
  // setxattr returns 0 (the file exists; we accept but don't store).
  expect(
    await status((cb) => ops.setxattr("/xattr-backed.txt", "user.x", Buffer.from("v"), 0, 0, cb)),
  ).toBe(0);
  // listxattr returns an empty buffer.
  const lx = await callback((cb) => ops.listxattr("/xattr-backed.txt", cb));
  expect(lx.errno).toBe(0);
  expect((lx.result as Buffer).length).toBe(0);
  // removexattr returns ENODATA.
  expect(await status((cb) => ops.removexattr("/xattr-backed.txt", "user.x", cb))).toBe(-61);
});

test("FUSE ftruncate does not depend on fuse-native binding this", async () => {
  const { vfs } = await createNodeVirtualFileSystem();
  const ops = makeFUSEOps(vfs);

  const create = await callback((cb: (errno: number, result: unknown) => void) =>
    ops.create("/ftruncate-this.txt", 0o644, cb),
  );
  expect(create.errno).toBe(0);
  const fh = create.result as number;

  const payload = Buffer.from("abcdef", "utf8");
  expect(
    await status((cb) => ops.write("/ftruncate-this.txt", fh, payload, payload.byteLength, 0, cb)),
  ).toBe(payload.byteLength);

  const ftruncate = ops.ftruncate;
  expect(await status((cb) => ftruncate.call(undefined, "/ftruncate-this.txt", fh, 3, cb))).toBe(0);
  expect(await status((cb) => ops.flush("/ftruncate-this.txt", fh, cb))).toBe(0);
  expect(Buffer.from(vfs.readFileSync("/ftruncate-this.txt")).toString("utf8")).toBe("abc");
});
