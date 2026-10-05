// Adapts computerd's op table to what the vendored fuse-napi binding
// accepts. Kept apart from makeFUSEOps so the VFS driver and the
// local-only layer keep one simple shape, and the binding's rules live
// in one place.

import type { FuseOps } from "./driver.js";

// The kernel's sentinel nanosecond values, as fuse-napi passes them.
export const UTIME_NOW = 0x3fffffff;
export const UTIME_OMIT = 0x3ffffffe;

export interface Timespec {
  readonly seconds: number | bigint;
  readonly nanoseconds: number;
}

export interface BindingOpsOptions {
  /** Clock for UTIME_NOW. Injected for tests. */
  readonly now?: () => number;
}

/**
 * Returns the op table to hand to `new Fuse()`.
 *
 * fuse-napi validates the table before it mounts, and refuses three of
 * our entries: `error` is not an operation it knows, `init` is mutually
 * exclusive with the `initWithConfig` the mount adds, and
 * `getBufferStats` is not an operation at all.
 *
 * `utimens` is swapped for `utimensWithTimespec`. Plain `utimens` in
 * fuse-napi answers EOPNOTSUPP when either time is UTIME_NOW or
 * UTIME_OMIT, and that is what `touch`, `touch -m`, and most archive
 * tools send.
 */
export function toBindingOps(
  ops: FuseOps,
  options: BindingOpsOptions = {},
): Record<string, unknown> {
  const now = options.now ?? Date.now;
  const { getBufferStats: _stats, error: _error, init: _init, utimens, ...rest } = ops;

  const utimensWithTimespec = (
    path: string,
    atime: Timespec,
    mtime: Timespec,
    cb: (code: number) => void,
  ): void => {
    const omitAtime = atime.nanoseconds === UTIME_OMIT;
    const omitMtime = mtime.nanoseconds === UTIME_OMIT;
    if (omitAtime && omitMtime) {
      cb(0);
      return;
    }

    const apply = (currentAtime: number, currentMtime: number): void => {
      const resolve = (time: Timespec, current: number): number => {
        if (time.nanoseconds === UTIME_OMIT) return current;
        if (time.nanoseconds === UTIME_NOW) return now();
        return toMilliseconds(time);
      };
      utimens.call(ops, path, resolve(atime, currentAtime), resolve(mtime, currentMtime), cb);
    };

    if (!omitAtime && !omitMtime) {
      apply(0, 0);
      return;
    }

    // Only one side is changing. Keep the other as it is by reading it
    // back first, since our utimens always sets both.
    ops.getattr(path, (code, stat) => {
      if (code !== 0 || stat === null) {
        cb(code !== 0 ? code : -2);
        return;
      }
      apply(stat.atime.getTime(), stat.mtime.getTime());
    });
  };

  return { ...rest, utimensWithTimespec };
}

function toMilliseconds(time: Timespec): number {
  return Number(time.seconds) * 1000 + Math.trunc(time.nanoseconds / 1_000_000);
}
