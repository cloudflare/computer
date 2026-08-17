// Builds the environment a spawned command inherits from the daemon.
//
// This is an allowlist, not a denylist. The daemon's own environment
// carries its configuration and, when the host sets one, the shared
// secret that authorizes requests to its HTTP surface. Spreading all of
// it into every `shell.exec` child would hand that secret to any command
// the workspace runs, and a denylist would leak the next secret somebody
// adds. So nothing crosses unless it is named here.

// Variables a shell environment is expected to carry. PATH is the
// load-bearing one: /bin/sh falls back to a compiled-in default that
// covers /usr/bin, so dropping it leaves standard tools working while
// silently hiding anything an image installed elsewhere, which is a
// common pattern for language runtimes and vendored toolchains.
const FORWARDED = ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "TERM"] as const;

// Locale variables are a family rather than a fixed name.
const FORWARDED_PREFIX = "LC_";

// The operator's channel for reaching a command's environment. The
// prefix is stripped on the way through, so COMPUTER_VAR_NODE_ENV
// arrives as NODE_ENV.
export const ENV_VAR_PREFIX = "COMPUTER_VAR_";

export function inheritedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of FORWARDED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name.startsWith(FORWARDED_PREFIX)) env[name] = value;
  }

  // Applied last so an operator can deliberately replace one of the
  // standard variables, e.g. COMPUTER_VAR_PATH to pin a toolchain.
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!name.startsWith(ENV_VAR_PREFIX)) continue;
    const stripped = name.slice(ENV_VAR_PREFIX.length);
    if (stripped.length === 0) continue;
    env[stripped] = value;
  }

  return env;
}
