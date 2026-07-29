// Tests the shape build-bundle.mjs produces in generated-bundle.ts.
//
// The bundle used to be a single ~3 MB JS string assigned to
// SHELL_BUNDLE. esbuild was inlining every dynamic import()
// just-bash makes (python3, js-exec, sqlite3, html-to-markdown,
// curl, …) into the one string, so workerd's Worker Loader
// parsed all of it on every cold start even though the default
// ShellWorker disables python, javascript, and network.
//
// build-bundle.mjs now runs esbuild with splitting: true and
// emits a record of module name → source. The host Worker
// spreads the whole record into the Loader callback's modules
// table; workerd parses each chunk on first import, so the
// dynamic ones stay cold until a script actually reaches for
// them. These tests are the contract.

import { describe, expect, it } from "vitest";

import { SHELL_MODULES } from "./generated-bundle.js";

describe("SHELL_MODULES", () => {
  it("exposes shell.js as the main module", () => {
    expect(SHELL_MODULES["shell.js"]).toBeDefined();
    expect(typeof SHELL_MODULES["shell.js"].js).toBe("string");
    expect(SHELL_MODULES["shell.js"].js.length).toBeGreaterThan(0);
  });

  it("keeps the main module under 1 MB so cold start parses ~650 KB, not 3 MB", () => {
    // Static-reachable set from entrypoint.ts measured at ~651 KB.
    // Anything materially above that means esbuild stopped
    // splitting and went back to inlining dynamic imports.
    const mainBytes = SHELL_MODULES["shell.js"].js.length;
    expect(mainBytes).toBeLessThan(1_000_000);
  });

  it("splits dynamic just-bash chunks into separate modules", () => {
    // The whole point of (2): the bundle is no longer one blob.
    // At least one chunk besides shell.js should be present.
    const names = Object.keys(SHELL_MODULES);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain("shell.js");
  });

  it("emits chunk module names with a .js extension", () => {
    // workerd's Worker Loader rejects extensionless module names
    // for bare-string modules; chunks must keep their .js suffix.
    for (const name of Object.keys(SHELL_MODULES)) {
      expect(name.endsWith(".js")).toBe(true);
    }
  });

  it("every module entry has a js source string", () => {
    for (const [name, mod] of Object.entries(SHELL_MODULES)) {
      expect(typeof mod.js, `module ${name}`).toBe("string");
      expect(mod.js.length, `module ${name} non-empty`).toBeGreaterThan(0);
    }
  });
});
