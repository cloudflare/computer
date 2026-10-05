import { describe, expect, test } from "vitest";

import { toBindingOps, UTIME_NOW, UTIME_OMIT } from "./binding-ops.js";
import type { FuseOps, FuseStat } from "./driver.js";

const MTIME = Date.UTC(2020, 0, 1);
const ATIME = Date.UTC(2021, 0, 1);

function fakeOps(getattrErrno = 0) {
  const utimens: Array<[string, number, number]> = [];
  const ops = {
    init: (cb?: (code: number) => void) => cb?.(0),
    error: () => {},
    getBufferStats: () => ({}),
    getattr(_path: string, cb: (code: number, stat: FuseStat | null) => void) {
      if (getattrErrno !== 0) {
        cb(getattrErrno, null);
        return;
      }
      cb(0, { atime: new Date(ATIME), mtime: new Date(MTIME) } as FuseStat);
    },
    utimens(path: string, atime: number, mtime: number, cb: (code: number) => void) {
      utimens.push([path, atime, mtime]);
      cb(0);
    },
    readdir(_path: string, cb: (code: number, names: string[]) => void) {
      cb(0, []);
    },
  } as unknown as FuseOps;
  return { ops, utimens };
}

type BindingUtimens = (
  path: string,
  atime: { seconds: number | bigint; nanoseconds: number },
  mtime: { seconds: number | bigint; nanoseconds: number },
  cb: (code: number) => void,
) => void;

function call(ops: Record<string, unknown>, atime: object, mtime: object): Promise<number> {
  const fn = ops.utimensWithTimespec as BindingUtimens;
  return new Promise((resolve) =>
    fn("/f", atime as never, mtime as never, (code: number) => resolve(code)),
  );
}

describe("toBindingOps", () => {
  test("drops the entries fuse-napi refuses", () => {
    // `error` is not an operation it knows, `init` is mutually exclusive
    // with the initWithConfig the mount adds, and getBufferStats is not
    // an operation at all.
    const out = toBindingOps(fakeOps().ops);
    expect(out).not.toHaveProperty("error");
    expect(out).not.toHaveProperty("init");
    expect(out).not.toHaveProperty("getBufferStats");
    expect(out).toHaveProperty("readdir");
  });

  test("replaces utimens with the timespec variant", () => {
    // Plain utimens in fuse-napi answers EOPNOTSUPP whenever the kernel
    // sends UTIME_NOW or UTIME_OMIT, which is what a bare `touch` does.
    const out = toBindingOps(fakeOps().ops);
    expect(out).not.toHaveProperty("utimens");
    expect(typeof out.utimensWithTimespec).toBe("function");
  });

  test("converts explicit times to milliseconds", async () => {
    const { ops, utimens } = fakeOps();
    const out = toBindingOps(ops);
    const code = await call(
      out,
      { seconds: 10, nanoseconds: 500_000_000 },
      { seconds: 20n, nanoseconds: 0 },
    );
    expect(code).toBe(0);
    expect(utimens).toEqual([["/f", 10_500, 20_000]]);
  });

  test("resolves UTIME_NOW to the current time", async () => {
    const { ops, utimens } = fakeOps();
    const out = toBindingOps(ops, { now: () => 1234 });
    await call(out, { seconds: 0, nanoseconds: UTIME_NOW }, { seconds: 0, nanoseconds: UTIME_NOW });
    expect(utimens).toEqual([["/f", 1234, 1234]]);
  });

  test("keeps the current value for UTIME_OMIT, so touch -m leaves atime alone", async () => {
    const { ops, utimens } = fakeOps();
    const out = toBindingOps(ops, { now: () => 1234 });
    await call(
      out,
      { seconds: 0, nanoseconds: UTIME_OMIT },
      { seconds: 0, nanoseconds: UTIME_NOW },
    );
    expect(utimens).toEqual([["/f", ATIME, 1234]]);
  });

  test("does nothing when both times are omitted", async () => {
    const { ops, utimens } = fakeOps();
    const out = toBindingOps(ops);
    const code = await call(
      out,
      { seconds: 0, nanoseconds: UTIME_OMIT },
      { seconds: 0, nanoseconds: UTIME_OMIT },
    );
    expect(code).toBe(0);
    expect(utimens).toEqual([]);
  });

  test("reports the getattr error when an omitted time cannot be read", async () => {
    const { ops, utimens } = fakeOps(-2);
    const out = toBindingOps(ops);
    const code = await call(
      out,
      { seconds: 0, nanoseconds: UTIME_OMIT },
      { seconds: 5, nanoseconds: 0 },
    );
    expect(code).toBe(-2);
    expect(utimens).toEqual([]);
  });
});
