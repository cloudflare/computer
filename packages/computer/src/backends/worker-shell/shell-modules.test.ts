// Tests the groups build-bundle.mjs emits under generated/ and the
// import-based assembly shell-modules.ts performs on top of them.
//
// build-bundle.mjs runs esbuild with splitting: true and partitions
// the emitted modules into a core group (every always-on command
// plus the ShellWorker entry) and one group per optional command
// (curl included), each published on its own
// @cloudflare/computer/shell/* subpath. shell-modules.ts imports
// only the core group; a consumer opts a command in by importing
// its group and passing it to assembleShellModules (or to
// WorkerBackend's `commands` option). A group the consumer never
// imports is unreachable in their bundle and drops out. These tests
// are the contract.

import curlModules from "@cloudflare/computer/shell/curl";
import fileModules from "@cloudflare/computer/shell/file";
import htmlToMarkdownModules from "@cloudflare/computer/shell/html-to-markdown";
import jqModules from "@cloudflare/computer/shell/jq";
import jsExecModules from "@cloudflare/computer/shell/js-exec";
import pythonModules from "@cloudflare/computer/shell/python";
import sqliteModules from "@cloudflare/computer/shell/sqlite";
import xanModules from "@cloudflare/computer/shell/xan";
import yqModules from "@cloudflare/computer/shell/yq";
import { describe, expect, it } from "vitest";
import { assembleShellModules, SHELL_CORE_MODULES } from "./shell-modules.js";

const OPTIONAL_GROUPS = {
  curl: curlModules,
  "html-to-markdown": htmlToMarkdownModules,
  python: pythonModules,
  sqlite: sqliteModules,
  "js-exec": jsExecModules,
  yq: yqModules,
  file: fileModules,
  xan: xanModules,
  jq: jqModules,
};

describe("SHELL_CORE_MODULES", () => {
  it("exposes shell.js as the main module", () => {
    expect(SHELL_CORE_MODULES["shell.js"]).toBeDefined();
    expect(typeof SHELL_CORE_MODULES["shell.js"].js).toBe("string");
    expect(SHELL_CORE_MODULES["shell.js"].js.length).toBeGreaterThan(0);
  });

  it("keeps the main module under 1 MB so cold start parses ~650 KB, not 3 MB", () => {
    // Static-reachable set from entrypoint.ts measured at ~651 KB.
    // Anything materially above that means esbuild stopped
    // splitting and went back to inlining dynamic imports.
    const mainBytes = SHELL_CORE_MODULES["shell.js"].js.length;
    expect(mainBytes).toBeLessThan(1_000_000);
  });

  it("splits dynamic just-bash chunks into separate modules", () => {
    // The whole point of splitting: the bundle is no longer one
    // blob. At least one chunk besides shell.js should be present.
    const names = Object.keys(SHELL_CORE_MODULES);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain("shell.js");
  });

  it("emits chunk module names with a .js extension", () => {
    // workerd's Worker Loader rejects extensionless module names
    // for bare-string modules; chunks must keep their .js suffix.
    for (const name of Object.keys(SHELL_CORE_MODULES)) {
      expect(name.endsWith(".js")).toBe(true);
    }
  });

  it("every module entry has a js source string", () => {
    for (const [name, mod] of Object.entries(SHELL_CORE_MODULES)) {
      expect(typeof mod.js, `module ${name}`).toBe("string");
      expect(mod.js.length, `module ${name} non-empty`).toBeGreaterThan(0);
    }
  });

  it("carries no optional command's chunks", () => {
    // Every optional command lives in its own group; core holds
    // none of them. Importing a group is the only way to ship it.
    for (const [feature, groupModules] of Object.entries(OPTIONAL_GROUPS)) {
      const names = Object.keys(groupModules);
      expect(names.length, `${feature} group non-empty on disk`).toBeGreaterThan(0);
      for (const name of names) {
        expect(
          SHELL_CORE_MODULES[name],
          `${feature} chunk ${name} absent from core`,
        ).toBeUndefined();
      }
    }
  });

  it("excludes the real undici dependency, leaving only the stub", () => {
    // undici is redirected to a throwing stub at bundle time, so
    // even when curl is included it runs on the fetch path and the
    // ~620 KB real dependency never ships. The stub marker lives in
    // core (the secure-fetch seam), so it is present by default.
    const marker = "undici is excluded from the Worker shell bundle";
    const stubPresent = Object.values(SHELL_CORE_MODULES).some((mod) => mod.js.includes(marker));
    expect(stubPresent).toBe(true);
  });
});

describe("assembleShellModules", () => {
  it("returns core only when no groups are passed", () => {
    const assembled = assembleShellModules();
    expect(Object.keys(assembled).sort()).toEqual(Object.keys(SHELL_CORE_MODULES).sort());
  });

  it("folds an imported group in on top of core", () => {
    const assembled = assembleShellModules([curlModules]);
    // Core is still there.
    expect(assembled["shell.js"]).toBeDefined();
    // curl's chunks are now present.
    for (const name of Object.keys(curlModules)) {
      expect(assembled[name], `curl chunk ${name} present`).toBeDefined();
    }
    // A group that was not passed stays out.
    for (const name of Object.keys(sqliteModules)) {
      expect(assembled[name], `sqlite chunk ${name} absent`).toBeUndefined();
    }
  });

  it("folds multiple imported groups in", () => {
    const assembled = assembleShellModules([curlModules, sqliteModules]);
    for (const name of [...Object.keys(curlModules), ...Object.keys(sqliteModules)]) {
      expect(assembled[name], `chunk ${name} present`).toBeDefined();
    }
  });
});

describe("shell feature groups", () => {
  it("keeps curl in its own group with its arg-check message", () => {
    const curlOnDisk = Object.values(curlModules).some((mod) =>
      mod.js.includes("curl: no URL specified"),
    );
    expect(curlOnDisk).toBe(true);
  });

  it("keeps feature groups disjoint from each other", () => {
    // A chunk owned by one feature must not also appear in another;
    // a shared chunk belongs in core.
    const entries = Object.entries(OPTIONAL_GROUPS);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [aName, aMods] = entries[i];
        const [bName, bMods] = entries[j];
        const aKeys = new Set(Object.keys(aMods));
        for (const name of Object.keys(bMods)) {
          expect(aKeys.has(name), `${name} in both ${aName} and ${bName}`).toBe(false);
        }
      }
    }
  });
});
