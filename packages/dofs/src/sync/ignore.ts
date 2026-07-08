// Path segment matcher for the container-side ignore list. The
// container uses this to drop paths from coalesceChanges before
// they hit the wire; the DO's Workspace.fs surface uses the same
// helper to make ignored paths invisible to API consumers.
//
// Matching is whole-segment: "node_modules" matches the segment
// node_modules anywhere in the path but does not match
// node_modules_old or my_node_modules. Patterns are plain strings,
// not globs; we can extend to globs later if a real case demands it.

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
