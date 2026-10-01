// FUSE mount option assembly, for libfuse 3.
//
// Split into two parts because libfuse 3 moved some of these out of the
// mount option string and into the init config:
//
//   - buildFuseOptionString() emits what still belongs on the command
//     line: use_ino, max_read, and the metadata timeouts.
//   - buildFuseInitConfig() emits max_write, which libfuse 3 only
//     accepts through fuse_conn_info at init.
//
// The defaults are the production-safe profile derived from the
// benchmark report and the mtime-propagation contract tests.
// attr_timeout, entry_timeout, and ac_attr_timeout sit at one second so
// stat-heavy tools (find, ls -l, git status) skip repeated FUSE
// round-trips. negative_timeout stays at zero so a just-written file
// shows up immediately to a process that probed before it existed.
// use_ino tells the kernel to trust the inode numbers returned by
// getattr, which is required for hardlinks to stat as the same inode.
// 512 KiB max_read and max_write match the dofs CHUNK_SIZE so a single
// FUSE read maps to a single chunk fetch.
//
// Two options the libfuse 2.9 build set are deliberately gone:
//
//   - big_writes. libfuse 3 removed it; batching up to max_write is the
//     default there, which is what the option used to buy.
//   - auto_cache. libfuse sets keep_cache *after* the open callback
//     returns and does not check for passthrough, and the kernel
//     refuses FOPEN_PASSTHROUGH combined with FOPEN_KEEP_CACHE
//     (fs/fuse/iomode.c) with EIO. The driver now decides keepCache per
//     open instead, applying auto_cache's own rule — reuse the cache
//     when mtime and size are unchanged since the last open — for
//     VFS-backed files only. See resolveKeepCache in driver.ts.
//
// Every default is opt-out via the matching COMPUTERD_FUSE_* env var.
// Setting an option to "0", "false", "no", "off", or "" turns it off; a
// positive value overrides the default.

// 512 KiB matches the dofs CHUNK_SIZE so a single FUSE read maps to a
// single chunk fetch. Earlier defaults at 128 KiB issued four reads
// per chunk and four SQL lookups for the same blob.
const DEFAULT_MAX_READ = 524288;
const DEFAULT_MAX_WRITE = 524288;
const DEFAULT_ATTR_TIMEOUT = "1";
const DEFAULT_ENTRY_TIMEOUT = "1";
const DEFAULT_AC_ATTR_TIMEOUT = "1";
const DEFAULT_NEGATIVE_TIMEOUT = "0";

// Options that must never reach the mount.
//
//   - big_writes: removed in libfuse 3, which fails the mount on it.
//   - max_write: init config in libfuse 3, not a mount option.
//   - auto_cache / kernel_cache: incompatible with passthrough, and the
//     driver now owns the keep-cache decision per open.
//   - writeback_cache: possible under libfuse 3 but it changes
//     behaviour for the synced mount; a separate change.
const DISALLOWED_OPTS = new Set([
  "big_writes",
  "max_write",
  "auto_cache",
  "kernel_cache",
  "writeback_cache",
]);

export interface FuseOptionEnv {
  COMPUTERD_FUSE_MAX_READ?: string;
  COMPUTERD_FUSE_MAX_WRITE?: string;
  COMPUTERD_FUSE_ATTR_TIMEOUT?: string;
  COMPUTERD_FUSE_ENTRY_TIMEOUT?: string;
  COMPUTERD_FUSE_NEGATIVE_TIMEOUT?: string;
  COMPUTERD_FUSE_AC_ATTR_TIMEOUT?: string;
  COMPUTERD_FUSE_EXTRA_OPTS?: string;
}

/** The subset of the libfuse 3 init config computerd sets. */
export interface FuseInitConfig {
  /** Maximum bytes per write request. Mount option in 2.9, init in 3. */
  readonly maxWrite: number;
  /**
   * Stacking depth allowed for a passthrough backing file. 1 covers a
   * backing store on overlayfs; without it registration fails ELOOP.
   */
  readonly maxBackingStackDepth: number;
}

/**
 * Build the init config handed to libfuse 3 from the init callback.
 *
 * Separate from the option string because libfuse 3 rejects max_write as
 * a mount option, so the two cannot be assembled together.
 */
export function buildFuseInitConfig(env: FuseOptionEnv): FuseInitConfig {
  return {
    maxWrite: parsePositiveInt(env.COMPUTERD_FUSE_MAX_WRITE) ?? DEFAULT_MAX_WRITE,
    maxBackingStackDepth: 1,
  };
}

/**
 * Build the comma-separated mount option string. Pure function over an
 * env-like object, so tests can drive it directly.
 */
export function buildFuseOptionString(env: FuseOptionEnv): string {
  const opts: string[] = ["use_ino"];

  const maxRead = parsePositiveInt(env.COMPUTERD_FUSE_MAX_READ) ?? DEFAULT_MAX_READ;
  opts.push(`max_read=${maxRead}`);

  pushTimeout(opts, "attr_timeout", env.COMPUTERD_FUSE_ATTR_TIMEOUT, DEFAULT_ATTR_TIMEOUT);
  pushTimeout(opts, "entry_timeout", env.COMPUTERD_FUSE_ENTRY_TIMEOUT, DEFAULT_ENTRY_TIMEOUT);
  pushTimeout(
    opts,
    "negative_timeout",
    env.COMPUTERD_FUSE_NEGATIVE_TIMEOUT,
    DEFAULT_NEGATIVE_TIMEOUT,
  );
  pushTimeout(opts, "ac_attr_timeout", env.COMPUTERD_FUSE_AC_ATTR_TIMEOUT, DEFAULT_AC_ATTR_TIMEOUT);

  const extra = env.COMPUTERD_FUSE_EXTRA_OPTS;
  if (extra !== undefined && extra !== "") {
    for (const part of extra.split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const head = trimmed.split("=")[0];
      if (head !== undefined && DISALLOWED_OPTS.has(head)) continue;
      opts.push(trimmed);
    }
  }

  return opts.join(",");
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function pushTimeout(
  opts: string[],
  name: string,
  raw: string | undefined,
  fallback?: string,
): void {
  // Distinguish unset (use the default) from explicit empty (turn the
  // option off). Unset is undefined here; explicit empty is "".
  const effective = raw === undefined ? fallback : raw === "" ? undefined : raw;
  const n = parseNonNegativeNumber(effective);
  if (n === undefined) return;
  // libfuse accepts integers and fractional seconds. Preserve the
  // operator's literal where it parses cleanly so "0.5" stays as
  // "0.5" rather than dropping precision through Number formatting.
  const formatted = effective !== undefined && Number(effective) === n ? effective : String(n);
  opts.push(`${name}=${formatted}`);
}
