// The dofs chunk size, so one FUSE request maps to one chunk fetch.
const DEFAULT_REQUEST_SIZE = 512 * 1024;

// One second of attribute and entry caching saves round trips for tools
// that stat repeatedly (find, ls -l, git status). Failed lookups are never
// cached, so a file another process has just created is visible at once.
const DEFAULT_TIMEOUTS = { attrTimeout: 1, entryTimeout: 1, negativeTimeout: 0 } as const;

type TimeoutOption = keyof typeof DEFAULT_TIMEOUTS;

// Dropped from COMPUTERD_FUSE_EXTRA_OPTS rather than allowed to fail the
// mount. libfuse 3 removed big_writes and moved max_write into the init
// config. The kernel refuses auto_cache and kernel_cache on a passthrough
// open, so the driver decides keepCache per open instead, and
// ac_attr_timeout only tunes auto_cache. writeback_cache would change write
// behavior on the synced mount.
const IGNORED_EXTRA_OPTS = new Set([
  "big_writes",
  "max_write",
  "auto_cache",
  "kernel_cache",
  "ac_attr_timeout",
  "writeback_cache",
]);

export interface FuseOptionEnv {
  COMPUTERD_FUSE_MAX_READ?: string;
  COMPUTERD_FUSE_MAX_WRITE?: string;
  COMPUTERD_FUSE_ATTR_TIMEOUT?: string;
  COMPUTERD_FUSE_ENTRY_TIMEOUT?: string;
  COMPUTERD_FUSE_NEGATIVE_TIMEOUT?: string;
  COMPUTERD_FUSE_EXTRA_OPTS?: string;
  COMPUTERD_FUSE_PASSTHROUGH?: string;
}

type OptionValue = boolean | number | string;

/** Mount options in the binding's spelling: camelCase names, flags as `true`. */
export type FuseMountOptions = Readonly<Record<string, OptionValue>>;

export interface FuseInitConfig {
  readonly maxWrite: number;
  readonly maxBackingStackDepth: number;
}

export function buildFuseInitConfig(env: FuseOptionEnv): FuseInitConfig {
  return {
    maxWrite: parsePositiveInt(env.COMPUTERD_FUSE_MAX_WRITE) ?? DEFAULT_REQUEST_SIZE,
    // Lets a passthrough backing file sit on overlayfs, the usual
    // container root. Without it registration fails with ELOOP.
    maxBackingStackDepth: 1,
  };
}

export function buildFuseMountOptions(env: FuseOptionEnv): FuseMountOptions {
  return {
    // Trust getattr's inode numbers, so hard links stat as one inode.
    useIno: true,
    maxRead: parsePositiveInt(env.COMPUTERD_FUSE_MAX_READ) ?? DEFAULT_REQUEST_SIZE,
    ...timeoutOption("attrTimeout", env.COMPUTERD_FUSE_ATTR_TIMEOUT),
    ...timeoutOption("entryTimeout", env.COMPUTERD_FUSE_ENTRY_TIMEOUT),
    ...timeoutOption("negativeTimeout", env.COMPUTERD_FUSE_NEGATIVE_TIMEOUT),
    ...parseExtraOptions(env.COMPUTERD_FUSE_EXTRA_OPTS),
  };
}

export function passthroughRequested(env: FuseOptionEnv): boolean {
  const value = env.COMPUTERD_FUSE_PASSTHROUGH?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

// An unset variable keeps the default and an empty one turns the option off.
function timeoutOption(name: TimeoutOption, raw: string | undefined): Record<string, number> {
  if (raw === "") return {};
  const value = raw === undefined ? DEFAULT_TIMEOUTS[name] : parseNonNegativeNumber(raw);
  return value === undefined ? {} : { [name]: value };
}

// Entries use libfuse's spelling ("allow_other,fsname=x") and are renamed
// to the binding's, so an entry overrides a default instead of conflicting
// with it. An unknown name still fails the mount, in the binding.
function parseExtraOptions(extra: string | undefined): Record<string, OptionValue> {
  const options: Record<string, OptionValue> = {};
  for (const entry of (extra ?? "").split(",")) {
    const [name = "", value] = splitOnce(entry.trim(), "=");
    if (name === "" || IGNORED_EXTRA_OPTS.has(name)) continue;
    options[toCamelCase(name)] = value === undefined ? true : parseOptionValue(value);
  }
  return options;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  return index === -1 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

function toCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function parseOptionValue(raw: string): number | string {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseNonNegativeNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
