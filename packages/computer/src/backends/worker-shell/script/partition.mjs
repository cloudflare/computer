// Pure partitioning logic for build-bundle.mjs, split out so it can
// be unit-tested against synthetic module graphs without running a
// real esbuild bundle.
//
// The problem: esbuild emits shell.js plus a flat set of
// chunk-<hash>.js code-split fragments. We assign each fragment to
// exactly one group — "core" (always shipped) or one optional
// command feature — so a consumer that never imports a feature's
// group drops the feature's exclusive chunks from its bundle.
//
// Two independent facts drive the assignment, and they come from
// two different sources on purpose:
//
//   1. The module graph — which chunk imports which, and whether
//      the edge is a static `import` or a lazy `import()`. This
//      comes from esbuild's metafile (imports[].kind), not from
//      scraping the emitted source. The metafile is esbuild's own
//      structured account of the graph, so it survives codegen and
//      minification changes that would break a text scrape.
//
//   2. Command identity — which chunks are just-bash *commands*
//      (curl, python3, …) versus internal diagnostics that also
//      lazy-load chunks (e.g. flag-coverage, which fans out to
//      every command). Only just-bash's `{ name, load }` registry
//      in shell.js carries this: a diagnostic's dynamic edges must
//      not drag every command's heavy dependency into core, so we
//      follow dynamic edges only out of genuine commands. The
//      metafile can't distinguish the two — both look like
//      code-split entry points — so the registry parse stays.

import { basename } from "node:path";

// Build the module graph from esbuild's metafile `outputs`. Keys
// are output basenames (shell.js, chunk-<hash>.js) to match the
// modules record build-bundle.mjs assembles from result.outputFiles.
// Static and dynamic edges are kept apart so the partitioner can
// follow them selectively; external imports (node:*, workerd
// built-ins) are dropped since they resolve at runtime, not from
// the modules table.
export function buildModuleGraph(metafileOutputs) {
  const modules = new Set();
  const staticEdges = new Map();
  const dynamicEdges = new Map();
  const entryPointOf = new Map();
  for (const [output, meta] of Object.entries(metafileOutputs)) {
    const name = basename(output);
    modules.add(name);
    const staticTargets = new Set();
    const dynamicTargets = new Set();
    for (const edge of meta.imports ?? []) {
      if (edge.external) continue;
      const target = basename(edge.path);
      if (edge.kind === "dynamic-import") dynamicTargets.add(target);
      else if (edge.kind === "import-statement") staticTargets.add(target);
    }
    staticEdges.set(name, staticTargets);
    dynamicEdges.set(name, dynamicTargets);
    if (meta.entryPoint) entryPointOf.set(name, basename(meta.entryPoint));
  }
  return { modules, staticEdges, dynamicEdges, entryPointOf };
}

// Parse just-bash's lazy command registry out of shell.js. Each
// entry looks like
//   { name: "curl", load: async () => (await import("./chunk-…js")).curlCommand }
// Returns a command-name -> chunk-basename map. Diagnostics that
// lazy-load chunks through a different shape (flag-coverage's
// `{ …FlagCoverage } = await import(…)`) are deliberately not
// matched: they are not commands, and following their fan-out would
// pull every command's dependency into core.
export function parseCommandRegistry(shellSource) {
  const registry = {};
  const re =
    /\{\s*name:\s*"([^"]+)",\s*load:\s*async\s*\(\)\s*=>\s*\(await import\("(\.\/chunk-[^"]+)"\)\)/g;
  for (const match of shellSource.matchAll(re)) {
    registry[match[1]] = basename(match[2]);
  }
  return registry;
}

// Resolve each optional feature to the chunk(s) its command entries
// load. A feature may list several command names (aliases such as
// python/python3 or node/js-exec) that resolve to the same chunk;
// duplicates collapse. Throws when a feature resolves to nothing:
// that means the registry parse came back empty or the command
// names drifted, and silently continuing would fold the feature's
// heavy chunk into core — the exact regression the split exists to
// prevent. Also throws if a resolved chunk is missing from the
// module graph, which signals the registry and the emitted output
// have drifted apart.
export function resolveFeatureRoots(registry, optionalFeatures, modules) {
  const roots = new Map();
  for (const [feature, commands] of Object.entries(optionalFeatures)) {
    const chunks = new Set();
    for (const command of commands) {
      const chunk = registry[command];
      if (chunk !== undefined) chunks.add(chunk);
    }
    if (chunks.size === 0) {
      throw new Error(
        `partition: optional feature "${feature}" resolved no command chunk ` +
          `from the shell registry (commands: ${commands.join(", ")}). The ` +
          `registry parse likely broke or just-bash's command names changed; ` +
          `refusing to fold the feature's chunks into core silently.`,
      );
    }
    for (const chunk of chunks) {
      if (modules !== undefined && !modules.has(chunk)) {
        throw new Error(
          `partition: feature "${feature}" command chunk "${chunk}" is not in ` +
            `the emitted module set. The shell registry and the bundle output ` +
            `have drifted apart.`,
        );
      }
    }
    roots.set(feature, [...chunks]);
  }
  return roots;
}

// Assign every emitted module to exactly one group: "core" or one
// optional feature. A module belongs to a feature only when that
// feature is its sole reacher and core can't reach it; everything
// else — shared chunks, chunks a non-optional command reaches, the
// shell.js entry — stays in core. That invariant is what makes
// dropping one feature safe: no core code and no other feature can
// depend on a feature's exclusive chunks.
export function partitionModules({ graph, registry, optionalFeatures }) {
  const { modules, staticEdges, dynamicEdges } = graph;

  const closure = (starts, followDynamic) => {
    const seen = new Set();
    const stack = [...starts];
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current) || !modules.has(current)) continue;
      seen.add(current);
      for (const next of staticEdges.get(current) ?? []) stack.push(next);
      if (followDynamic) for (const next of dynamicEdges.get(current) ?? []) stack.push(next);
    }
    return seen;
  };

  const featureRoots = resolveFeatureRoots(registry, optionalFeatures, modules);
  const optionalCommands = new Set(Object.values(optionalFeatures).flat());

  // Core reach: everything statically pulled by shell.js (the
  // always-parsed entry) plus the full closure of every command
  // that isn't optional. Dynamic edges out of shell.js are the
  // per-command import() fan-out — following them would drag every
  // optional chunk into core, so core uses shell.js's static edges
  // only, then adds the closure of each kept command explicitly.
  const coreReach = closure(["shell.js"], /* followDynamic */ false);
  for (const [command, chunk] of Object.entries(registry)) {
    if (!optionalCommands.has(command)) {
      for (const name of closure([chunk], /* followDynamic */ true)) coreReach.add(name);
    }
  }

  const featureReach = new Map();
  for (const [feature, roots] of featureRoots) {
    featureReach.set(feature, closure(roots, /* followDynamic */ true));
  }

  const partition = { core: [] };
  for (const feature of Object.keys(optionalFeatures)) partition[feature] = [];
  for (const name of modules) {
    const optionalOwners = [];
    for (const feature of Object.keys(optionalFeatures)) {
      if (featureReach.get(feature).has(name)) optionalOwners.push(feature);
    }
    if (!coreReach.has(name) && optionalOwners.length === 1) {
      partition[optionalOwners[0]].push(name);
    } else {
      partition.core.push(name);
    }
  }
  return partition;
}
