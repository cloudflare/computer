// Path-segment matcher for an explicitly configured sync ignore list.
// Matching is whole-segment: a pattern matches that segment anywhere in
// the path, but does not match a longer segment. Patterns are plain
// strings, not globs; we can extend to globs later if a real case
// demands it.
//
// The default is intentionally empty. Ignoring paths is opt-in because
// the filesystem and sync surfaces should preserve the same namespace.

// Kept as a named export for callers that need the package default.
export const DEFAULT_IGNORE: string[] = [];

export function isIgnored(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  // canonicalizePath strips the trailing slash and leaves a leading
  // "/" for non-root paths; split skips the empty leading segment.
  const segments = path.split("/").filter((s) => s.length > 0);
  for (const segment of segments) {
    for (const p of patterns) {
      if (segment === p) return true;
    }
  }
  return false;
}
