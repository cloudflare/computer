import type { FuseOps } from "./driver.js";

// The kernel's sentinel nanosecond values, as fuse-napi passes them.
export const UTIME_NOW = 0x3fffffff;
export const UTIME_OMIT = 0x3ffffffe;

export interface Timespec {
  readonly seconds: number | bigint;
  readonly nanoseconds: number;
}

type StatusCallback = (code: number) => void;

export interface BindingOpsOptions {
  readonly now?: () => number;
}

/**
 * The op table to hand to `new Fuse()`.
 *
 * fuse-napi refuses `error` (not an operation it knows), `init` (mutually
 * exclusive with the `initWithConfig` the mount adds) and `getBufferStats`.
 * Its plain `utimens` answers EOPNOTSUPP whenever the kernel sends
 * UTIME_NOW or UTIME_OMIT, which is what `touch` does, so the timespec
 * variant is used instead.
 */
export function toBindingOps(
  ops: FuseOps,
  options: BindingOpsOptions = {},
): Record<string, unknown> {
  const { getBufferStats: _stats, error: _error, init: _init, utimens: _utimens, ...rest } = ops;
  return { ...rest, utimensWithTimespec: utimensWithTimespec(ops, options.now ?? Date.now) };
}

function utimensWithTimespec(ops: FuseOps, now: () => number) {
  return (path: string, atime: Timespec, mtime: Timespec, cb: StatusCallback): void => {
    const omitAtime = atime.nanoseconds === UTIME_OMIT;
    const omitMtime = mtime.nanoseconds === UTIME_OMIT;
    if (omitAtime && omitMtime) {
      cb(0);
      return;
    }

    const resolve = (time: Timespec, current: number): number => {
      if (time.nanoseconds === UTIME_OMIT) return current;
      if (time.nanoseconds === UTIME_NOW) return now();
      return toMilliseconds(time);
    };
    const apply = (currentAtime: number, currentMtime: number): void => {
      ops.utimens(path, resolve(atime, currentAtime), resolve(mtime, currentMtime), cb);
    };

    if (!omitAtime && !omitMtime) {
      apply(0, 0);
      return;
    }

    // Our utimens always sets both times, so read back the one being kept.
    ops.getattr(path, (code, stat) => {
      if (code !== 0 || stat === null) {
        cb(code !== 0 ? code : -2);
        return;
      }
      apply(stat.atime.getTime(), stat.mtime.getTime());
    });
  };
}

function toMilliseconds(time: Timespec): number {
  return Number(time.seconds) * 1000 + Math.trunc(time.nanoseconds / 1_000_000);
}
