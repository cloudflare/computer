// Unit tests for the bundle partitioner. These drive synthetic
// module graphs through the pure functions so the assignment rules
// are pinned without running a real esbuild bundle — the real bundle
// is exercised end-to-end by shell-modules.test.ts against the
// generated output.

import { describe, expect, it } from "vitest";

import {
  buildModuleGraph,
  parseCommandRegistry,
  partitionModules,
  resolveFeatureRoots,
} from "./partition.mjs";

describe("buildModuleGraph", () => {
  it("keys modules by output basename and splits static from dynamic edges", () => {
    const graph = buildModuleGraph({
      "out/shell.js": {
        imports: [
          { path: "out/chunk-core.js", kind: "import-statement" },
          { path: "out/chunk-curl.js", kind: "dynamic-import" },
        ],
      },
      "out/chunk-core.js": { imports: [] },
      "out/chunk-curl.js": { imports: [], entryPoint: "vendor/curl-ABCD1234.js" },
    });
    expect([...graph.modules].sort()).toEqual(["chunk-core.js", "chunk-curl.js", "shell.js"]);
    expect([...graph.staticEdges.get("shell.js")]).toEqual(["chunk-core.js"]);
    expect([...graph.dynamicEdges.get("shell.js")]).toEqual(["chunk-curl.js"]);
    expect(graph.entryPointOf.get("chunk-curl.js")).toBe("curl-ABCD1234.js");
  });

  it("drops external imports, which resolve at runtime not from the modules table", () => {
    const graph = buildModuleGraph({
      "out/shell.js": {
        imports: [
          { path: "node:fs", kind: "import-statement", external: true },
          { path: "out/chunk-core.js", kind: "import-statement" },
        ],
      },
      "out/chunk-core.js": { imports: [] },
    });
    expect([...graph.staticEdges.get("shell.js")]).toEqual(["chunk-core.js"]);
  });
});

describe("parseCommandRegistry", () => {
  it("maps command names to the chunk each lazy loader imports", () => {
    const source = `
      const commands = [
        { name: "curl", load: async () => (await import("./chunk-CURL1234.js")).curlCommand },
        { name: "jq", load: async () => (await import("./chunk-JQAB5678.js")).jqCommand },
      ];
    `;
    expect(parseCommandRegistry(source)).toEqual({
      curl: "chunk-CURL1234.js",
      jq: "chunk-JQAB5678.js",
    });
  });

  it("ignores diagnostics that lazy-load through a different shape", () => {
    // flag-coverage loads a chunk but is not a { name, load } command;
    // matching it would drag every command's dependency into core.
    const source = `
      const { instrumentFlagCoverage } = await import("./chunks/flag-coverage-THYQHOT3.js");
      const commands = [
        { name: "curl", load: async () => (await import("./chunk-CURL1234.js")).curlCommand },
      ];
    `;
    expect(parseCommandRegistry(source)).toEqual({ curl: "chunk-CURL1234.js" });
  });
});

describe("resolveFeatureRoots", () => {
  const modules = new Set(["shell.js", "chunk-curl.js", "chunk-python.js"]);

  it("collapses command aliases that resolve to the same chunk", () => {
    const registry = { python3: "chunk-python.js", python: "chunk-python.js" };
    const roots = resolveFeatureRoots(registry, { python: ["python3", "python"] }, modules);
    expect(roots.get("python")).toEqual(["chunk-python.js"]);
  });

  it("throws when a feature resolves to no chunk", () => {
    // An empty or drifted registry would otherwise fold the feature's
    // heavy chunk into core silently — the regression the split
    // exists to prevent.
    expect(() => resolveFeatureRoots({}, { curl: ["curl"] }, modules)).toThrow(
      /optional feature "curl" resolved no command chunk/,
    );
  });

  it("throws when a resolved chunk is absent from the module graph", () => {
    const registry = { curl: "chunk-missing.js" };
    expect(() => resolveFeatureRoots(registry, { curl: ["curl"] }, modules)).toThrow(
      /chunk "chunk-missing.js" is not in the emitted module set/,
    );
  });
});

describe("partitionModules", () => {
  // A synthetic graph shaped like the real one: shell.js statically
  // pulls its core, and lazy-loads commands. `diag` is a diagnostic
  // (not a registry command) that fans out to the optional curl
  // command; `req` is a required (non-optional) command. `shared` is
  // reachable from the required command, so it must stay in core even
  // though curl reaches it too.
  const outputs = {
    "out/shell.js": {
      imports: [
        { path: "out/chunk-corelib.js", kind: "import-statement" },
        { path: "out/chunk-req.js", kind: "dynamic-import" },
        { path: "out/chunk-curl.js", kind: "dynamic-import" },
        { path: "out/chunk-diag.js", kind: "dynamic-import" },
      ],
    },
    "out/chunk-corelib.js": { imports: [] },
    "out/chunk-req.js": {
      imports: [{ path: "out/chunk-shared.js", kind: "import-statement" }],
      entryPoint: "vendor/cat-REQ00000.js",
    },
    "out/chunk-curl.js": {
      imports: [
        { path: "out/chunk-shared.js", kind: "import-statement" },
        { path: "out/chunk-curlonly.js", kind: "import-statement" },
      ],
      entryPoint: "vendor/curl-CURL0000.js",
    },
    "out/chunk-curlonly.js": { imports: [] },
    "out/chunk-shared.js": { imports: [] },
    "out/chunk-diag.js": {
      imports: [{ path: "out/chunk-curl.js", kind: "dynamic-import" }],
      entryPoint: "vendor/flag-coverage-DIAG0000.js",
    },
  };
  const registry = {
    cat: "chunk-req.js",
    curl: "chunk-curl.js",
  };
  const optionalFeatures = { curl: ["curl"] };

  it("assigns a feature's exclusive chunk to that feature", () => {
    const graph = buildModuleGraph(outputs);
    const part = partitionModules({ graph, registry, optionalFeatures });
    expect(part.curl).toContain("chunk-curlonly.js");
    expect(part.curl).toContain("chunk-curl.js");
  });

  it("keeps a chunk a non-optional command reaches in core", () => {
    const graph = buildModuleGraph(outputs);
    const part = partitionModules({ graph, registry, optionalFeatures });
    // shared.js is reached by the required `cat` command, so it must
    // ship in core even though curl reaches it too.
    expect(part.core).toContain("chunk-shared.js");
    expect(part.curl).not.toContain("chunk-shared.js");
  });

  it("does not follow a diagnostic's dynamic fan-out into core", () => {
    const graph = buildModuleGraph(outputs);
    const part = partitionModules({ graph, registry, optionalFeatures });
    // diag lazy-loads curl, but diag is not a command; its fan-out
    // must not pull curl's exclusive chunk into core.
    expect(part.core).not.toContain("chunk-curlonly.js");
    // The diagnostic chunk itself has no single optional owner, so it
    // lands in core.
    expect(part.core).toContain("chunk-diag.js");
  });

  it("keeps shell.js and statically-reachable core in core", () => {
    const graph = buildModuleGraph(outputs);
    const part = partitionModules({ graph, registry, optionalFeatures });
    expect(part.core).toContain("shell.js");
    expect(part.core).toContain("chunk-corelib.js");
  });

  it("keeps a chunk two features share in core", () => {
    // fa and fb are both optional; a chunk both reach has more than
    // one optional owner, so it belongs in core, not in either group.
    const twoFeatureOutputs = {
      "out/shell.js": {
        imports: [
          { path: "out/chunk-fa.js", kind: "dynamic-import" },
          { path: "out/chunk-fb.js", kind: "dynamic-import" },
        ],
      },
      "out/chunk-fa.js": {
        imports: [{ path: "out/chunk-both.js", kind: "import-statement" }],
        entryPoint: "vendor/xan-FA000000.js",
      },
      "out/chunk-fb.js": {
        imports: [{ path: "out/chunk-both.js", kind: "import-statement" }],
        entryPoint: "vendor/jq-FB000000.js",
      },
      "out/chunk-both.js": { imports: [] },
    };
    const graph = buildModuleGraph(twoFeatureOutputs);
    const part = partitionModules({
      graph,
      registry: { xan: "chunk-fa.js", jq: "chunk-fb.js" },
      optionalFeatures: { xan: ["xan"], jq: ["jq"] },
    });
    expect(part.core).toContain("chunk-both.js");
    expect(part.xan).toEqual(["chunk-fa.js"]);
    expect(part.jq).toEqual(["chunk-fb.js"]);
  });
});
