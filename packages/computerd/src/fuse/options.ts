// FUSE mount option assembly.
//
// fuse-native (libfuse 2.9) doesn't expose most of the interesting
// mount options through its constructor, so the driver monkey-patches
// _fuseOptions() to append a comma-separated extra option string.
// Centralizing the assembly here gives us a pure function we can unit
// test, and gives operators a documented set of env vars to flip when
// experimenting.
//
// The defaults are the production-safe profile derived from the
// benchmark report and the mtime-propagation contract tests on the
// apply path. auto_cache is on; the kernel keeps the page cache
// across reads until the file is reopened with a different mtime or
// size. attr_timeout, entry_timeout, and ac_attr_timeout sit at one
// second so stat-heavy tools (find, ls -l, git status) skip repeated
// FUSE round-trips. negative_timeout stays at zero so a just-written
// file shows up immediately to a process that probed before it
// existed. use_ino tells the kernel to trust the inode numbers
// returned by getattr, which is required for hardlinks to stat as the
// same inode. big_writes plus 512 KiB max_read and max_write match
// the dofs CHUNK_SIZE so a single FUSE read maps to a single chunk
// fetch instead of four 128 KiB slices of the same blob.
//
// Every default is opt-out via the matching COMPUTERD_FUSE_* env var.
// Setting an option to "0", "false", "no", "off", or "" turns it
// off; a positive value overrides the default.
//
// Disallowed options (writeback_cache) are stripped defensively because
// libfuse 2.9 fails the whole mount with "unknown option" when it sees
// them. A typo in COMPUTERD_FUSE_EXTRA_OPTS shouldn't take the daemon down.

// 512 KiB matches the dofs CHUNK_SIZE so a single FUSE read maps to a
// single chunk fetch. Earlier defaults at 128 KiB issued four reads
// per chunk and four SQL lookups for the same blob.
const DEFAULT_MAX_READ = 524288;
const DEFAULT_MAX_WRITE = 524288;
const DEFAULT_AUTO_CACHE = true;
const DEFAULT_ATTR_TIMEOUT = "1";
const DEFAULT_ENTRY_TIMEOUT = "1";
const DEFAULT_AC_ATTR_TIMEOUT = "1";
const DEFAULT_NEGATIVE_TIMEOUT = "0";

// libfuse 2.9 does not understand these. Reject them at assembly time
// so a typo in EXTRA_OPTS doesn't fail the mount on startup.
const DISALLOWED_OPTS = new Set(["writeback_cache"]);

export interface FuseOptionEnv {
  COMPUTERD_FUSE_MAX_READ?: string;
  COMPUTERD_FUSE_MAX_WRITE?: string;
  COMPUTERD_FUSE_AUTO_CACHE?: string;
  COMPUTERD_FUSE_KERNEL_CACHE?: string;
  COMPUTERD_FUSE_ATTR_TIMEOUT?: string;
  COMPUTERD_FUSE_ENTRY_TIMEOUT?: string;
  COMPUTERD_FUSE_NEGATIVE_TIMEOUT?: string;
  COMPUTERD_FUSE_AC_ATTR_TIMEOUT?: string;
  COMPUTERD_FUSE_EXTRA_OPTS?: string;
}

/**
 * Build the comma-separated option string that the driver appends to
 * fuse-native's _fuseOptions() output. Pure function over an env-like
 * object, so tests can drive it directly.
 */
export function buildFuseOptionString(env: FuseOptionEnv): string {
  const opts: string[] = ["big_writes", "use_ino"];

  const maxWrite = parsePositiveInt(env.COMPUTERD_FUSE_MAX_WRITE) ?? DEFAULT_MAX_WRITE;
  const maxRead = parsePositiveInt(env.COMPUTERD_FUSE_MAX_READ) ?? DEFAULT_MAX_READ;
  opts.push(`max_write=${maxWrite}`);
  opts.push(`max_read=${maxRead}`);

  // libfuse 2.9 treats auto_cache and kernel_cache as alternative
  // strategies for the page cache, not stacking options. auto_cache wins
  // when both are set because it's the safer choice: it invalidates the
  // cache when mtime or size change, where kernel_cache never
  // invalidates. The driver could warn here, but the option string
  // itself is the durable artifact operators inspect when chasing
  // misconfiguration, so just emit the safer one and move on.
  const autoCache = parseBoolWithDefault(env.COMPUTERD_FUSE_AUTO_CACHE, DEFAULT_AUTO_CACHE);
  const kernelCache = parseBoolWithDefault(env.COMPUTERD_FUSE_KERNEL_CACHE, false);
  if (autoCache) {
    opts.push("auto_cache");
  } else if (kernelCache) {
    opts.push("kernel_cache");
  }

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
      if (DISALLOWED_OPTS.has(head)) continue;
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

// Resolves an env var to a boolean with a documented default. Unset
// (undefined) returns the default; an explicit "0" / "false" / "no" /
// "off" / "" turns the option off; anything else turns it on. The
// asymmetry between unset and empty matters: an operator who shells
// out `COMPUTERD_FUSE_AUTO_CACHE=` expects to disable the option, and that
// reaches this function as the empty string.
function parseBoolWithDefault(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
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
